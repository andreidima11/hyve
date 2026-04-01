"""
ComfyUI integration — queue txt2img workflows and retrieve generated images.

ComfyUI API:
  POST /prompt           → queue a workflow (returns {prompt_id})
  GET  /history/{id}     → poll for completion (returns output nodes)
  GET  /view?filename=…  → download the generated image

Workflow strategy:
  1. If config has workflow_json (inline JSON) → use that as template
  2. If config has workflow_file (path to .json) → load that as template
  3. Otherwise → auto-build based on checkpoint name (Flux / SD fallback)

  When using a template, the system finds prompt text nodes and substitutes
  the user's prompt. This way ANY model pipeline works — Flux, SD, SDXL,
  Lumina, AuraFlow, etc.
"""

import asyncio
import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx
import settings as settings_mod
from logger import log_line

# Directory where generated images are saved (served via /static/generated/)
GENERATED_DIR = os.path.join(os.path.dirname(__file__), "static", "generated")
os.makedirs(GENERATED_DIR, exist_ok=True)

# Directory for workflow templates
WORKFLOWS_DIR = os.path.join(os.path.dirname(__file__), "comfyui_workflows")
os.makedirs(WORKFLOWS_DIR, exist_ok=True)


def _cfg() -> Dict[str, Any]:
    return settings_mod.CFG.get("comfyui") or {}


def is_enabled() -> bool:
    cfg = _cfg()
    return bool(cfg.get("enabled") and (cfg.get("url") or "").strip())


def _base_url() -> str:
    return (_cfg().get("url") or "http://localhost:8188").rstrip("/")


# ---------------------------------------------------------------------------
# Workflow template — load, detect prompt nodes, substitute text
# ---------------------------------------------------------------------------

# Node class_types that contain the user's prompt text
_PROMPT_NODE_TYPES = {
    "CLIPTextEncode",
    "CLIPTextEncodeFlux",
    "CLIPTextEncodeSD3",
    "CLIPTextEncodeSDXL",
    "CLIPTextEncodeHunyuanDiT",
    "CLIPTextEncodePixArtAlpha",
    "CLIPTextEncodeLumina2",
}

# Node class_types that are negative-prompt / empty conditioning
_NEGATIVE_NODE_TYPES = {
    "ConditioningZeroOut",
}


def _load_workflow_template() -> Optional[Dict[str, Any]]:
    """Load a custom workflow template from config (inline JSON or file path).
    Returns None if no custom template is configured."""
    c = _cfg()

    # Priority 1: inline JSON in config
    wf_json = c.get("workflow_json")
    if wf_json and isinstance(wf_json, dict):
        return json.loads(json.dumps(wf_json))  # deep copy

    # Priority 2: file path
    wf_file = (c.get("workflow_file") or "").strip()
    if wf_file:
        # Resolve relative to project root
        if not os.path.isabs(wf_file):
            wf_file = os.path.join(os.path.dirname(__file__), wf_file)
        if os.path.isfile(wf_file):
            try:
                with open(wf_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                log_line("agent", "📋", "COMFYUI", f"Loaded workflow template: {wf_file}")
                return data
            except Exception as e:
                log_line("error", "⚠️", "COMFYUI", f"Failed to load workflow file {wf_file}: {e}")
        else:
            log_line("error", "⚠️", "COMFYUI", f"Workflow file not found: {wf_file}")

    return None


def _find_prompt_nodes(workflow: Dict[str, Any]) -> List[str]:
    """Find node IDs that contain the user's prompt text (text encoding nodes).
    Excludes nodes connected to negative/empty conditioning."""
    prompt_nodes = []
    negative_node_ids = set()

    # First pass: find negative conditioning nodes
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type in _NEGATIVE_NODE_TYPES:
            negative_node_ids.add(node_id)

    # Second pass: find KSampler-type nodes to identify which text node feeds "negative"
    negative_source_ids = set()
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        neg_input = inputs.get("negative")
        if isinstance(neg_input, list) and len(neg_input) >= 1:
            neg_source = str(neg_input[0])
            negative_source_ids.add(neg_source)
            # Also check if the negative feeds through ConditioningZeroOut
            if neg_source in workflow:
                neg_node = workflow[neg_source]
                if isinstance(neg_node, dict) and neg_node.get("class_type") in _NEGATIVE_NODE_TYPES:
                    # The source of ConditioningZeroOut is not a negative prompt
                    pass

    # Third pass: find actual text prompt nodes
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type in _PROMPT_NODE_TYPES:
            # Skip if this node feeds the negative input of a sampler
            if node_id in negative_source_ids and node_id not in negative_node_ids:
                # This is a negative prompt text node — skip it for positive prompt injection
                continue
            prompt_nodes.append(node_id)

    return prompt_nodes


def _inject_prompt_into_workflow(workflow: Dict[str, Any], prompt: str, seed: int = -1) -> Dict[str, Any]:
    """Inject the user's prompt text into the workflow template.
    Also randomizes the seed if present in KSampler nodes."""
    import random

    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    prompt_nodes = _find_prompt_nodes(workflow)

    if not prompt_nodes:
        # Fallback: find ANY text encoding node and inject
        for node_id, node in workflow.items():
            if not isinstance(node, dict):
                continue
            class_type = node.get("class_type", "")
            if class_type in _PROMPT_NODE_TYPES:
                prompt_nodes.append(node_id)
        if not prompt_nodes:
            raise RuntimeError(
                "Cannot find any text encoding node in the workflow template. "
                "The workflow must contain a CLIPTextEncode or similar node."
            )

    # Inject prompt into all identified prompt nodes
    for node_id in prompt_nodes:
        node = workflow[node_id]
        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {})

        if class_type == "CLIPTextEncodeFlux":
            inputs["clip_l"] = prompt
            inputs["t5xxl"] = prompt
        elif class_type == "CLIPTextEncodeSDXL":
            # SDXL has multiple text fields
            inputs["text_g"] = prompt
            inputs["text_l"] = prompt
        else:
            # Standard CLIPTextEncode and others
            inputs["text"] = prompt

    # Randomize seed in sampler nodes
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type in ("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"):
            inputs = node.get("inputs", {})
            if "seed" in inputs:
                inputs["seed"] = seed

    log_line("agent", "🎨", "COMFYUI",
             f"Injected prompt into {len(prompt_nodes)} node(s): {prompt_nodes}")
    return workflow


def _get_workflow_list() -> List[Dict[str, str]]:
    """List available workflow template files from comfyui_workflows/ directory."""
    workflows = []
    if os.path.isdir(WORKFLOWS_DIR):
        for fname in sorted(os.listdir(WORKFLOWS_DIR)):
            if fname.endswith(".json"):
                fpath = os.path.join(WORKFLOWS_DIR, fname)
                name = os.path.splitext(fname)[0]
                workflows.append({"name": name, "file": fname, "path": fpath})
    return workflows


# ---------------------------------------------------------------------------
# Model type detection (for auto-build fallback)
# ---------------------------------------------------------------------------

def _is_flux_checkpoint(name: str) -> bool:
    """Detect if checkpoint is a Flux model based on filename."""
    return "flux" in name.lower()


# ---------------------------------------------------------------------------
# Fallback: auto-built workflows when no template is provided
# ---------------------------------------------------------------------------

def _build_sd_workflow(
    prompt: str, negative_prompt: str, checkpoint: str, steps: int,
    cfg_scale: float, width: int, height: int, sampler: str,
    scheduler: str, seed: int,
) -> Dict[str, Any]:
    """Build a standard SD/SDXL ComfyUI API workflow."""
    return {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": cfg_scale,
            "sampler_name": sampler, "scheduler": scheduler, "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0],
            "negative": ["7", 0], "latent_image": ["5", 0]}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "memini", "images": ["8", 0]}},
    }


def _build_flux_workflow(
    prompt: str, checkpoint: str, steps: int, cfg_scale: float,
    width: int, height: int, sampler: str, scheduler: str, seed: int,
) -> Dict[str, Any]:
    """Build a Flux-compatible ComfyUI API workflow."""
    guidance = cfg_scale if cfg_scale > 0 else 3.5
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "10": {"class_type": "DualCLIPLoader", "inputs": {
            "clip_name1": "clip_l.safetensors",
            "clip_name2": "t5xxl_fp8_e4m3fn.safetensors", "type": "flux"}},
        "6": {"class_type": "CLIPTextEncodeFlux", "inputs": {
            "clip_l": prompt, "t5xxl": prompt, "guidance": guidance, "clip": ["10", 0]}},
        "7": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["6", 0]}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": 1.0,
            "sampler_name": sampler, "scheduler": scheduler, "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0],
            "negative": ["7", 0], "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "memini", "images": ["8", 0]}},
    }


# ---------------------------------------------------------------------------
# Unified workflow builder
# ---------------------------------------------------------------------------

async def _build_txt2img_workflow(
    prompt: str,
    negative_prompt: str = "",
    checkpoint: str = "",
    steps: int = 0,
    cfg_scale: float = 0,
    width: int = 0,
    height: int = 0,
    sampler: str = "",
    scheduler: str = "",
    seed: int = -1,
) -> Dict[str, Any]:
    """Build a ComfyUI workflow for txt2img.

    Strategy:
      1. Custom template (workflow_json or workflow_file) — inject prompt + seed
      2. Auto-build fallback based on checkpoint name (Flux / SD)
    """
    import random

    c = _cfg()
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)

    # ----- Strategy 1: custom workflow template -----
    template = _load_workflow_template()
    if template is not None:
        log_line("agent", "📋", "COMFYUI", "Using custom workflow template")
        return _inject_prompt_into_workflow(template, prompt, seed=seed)

    # ----- Strategy 2: auto-build -----
    checkpoint = checkpoint or c.get("default_checkpoint", "")
    steps = steps or int(c.get("default_steps", 20))
    cfg_scale = cfg_scale or float(c.get("default_cfg_scale", 7.0))
    width = width or int(c.get("default_width", 1024))
    height = height or int(c.get("default_height", 1024))
    sampler = sampler or c.get("default_sampler", "euler")
    scheduler = scheduler or c.get("default_scheduler", "normal")
    negative_prompt = negative_prompt or c.get("default_negative_prompt", "")

    # Auto-detect checkpoint if empty
    if not checkpoint.strip():
        log_line("agent", "🔍", "COMFYUI", "No checkpoint configured — auto-fetching...")
        try:
            available = await get_checkpoints()
            if available:
                checkpoint = available[0]
                log_line("agent", "🎨", "COMFYUI", f"Auto-selected checkpoint: {checkpoint}")
            else:
                raise RuntimeError(
                    "No checkpoint model configured and none found on ComfyUI. "
                    "Go to Settings → Integrations → ComfyUI and select a checkpoint, "
                    "or export a workflow template from ComfyUI and configure workflow_file."
                )
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"No checkpoint configured, auto-detect failed: {e}")

    if _is_flux_checkpoint(checkpoint):
        log_line("agent", "🎨", "COMFYUI", f"Using Flux workflow for: {checkpoint}")
        return _build_flux_workflow(prompt, checkpoint, steps, cfg_scale,
                                    width, height, sampler, scheduler, seed)
    else:
        log_line("agent", "🎨", "COMFYUI", f"Using SD/SDXL workflow for: {checkpoint}")
        return _build_sd_workflow(prompt, negative_prompt, checkpoint, steps,
                                  cfg_scale, width, height, sampler, scheduler, seed)


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

async def queue_prompt(workflow: Dict[str, Any]) -> str:
    """Queue a prompt workflow on ComfyUI. Returns the prompt_id."""
    url = f"{_base_url()}/prompt"
    payload = {"prompt": workflow, "client_id": str(uuid.uuid4())}
    timeout = float(_cfg().get("timeout", 120))

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            # Log the actual error body from ComfyUI for debugging
            try:
                err_body = resp.json()
                log_line("error", "⚠️", "COMFYUI", f"Queue error {resp.status_code}: {json.dumps(err_body, indent=2)[:500]}")
            except Exception:
                log_line("error", "⚠️", "COMFYUI", f"Queue error {resp.status_code}: {resp.text[:500]}")
            resp.raise_for_status()
        data = resp.json()
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return a prompt_id: {data}")
        log_line("agent", "🎨", "COMFYUI", f"Queued prompt_id={prompt_id}")
        return prompt_id


async def poll_until_done(prompt_id: str, poll_interval: float = 1.0) -> Dict[str, Any]:
    """Poll /history/{prompt_id} until the job is done. Returns the history entry."""
    url = f"{_base_url()}/history/{prompt_id}"
    timeout = float(_cfg().get("timeout", 120))
    deadline = time.time() + timeout

    async with httpx.AsyncClient(timeout=30) as client:
        while time.time() < deadline:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                data = resp.json()
                if prompt_id in data:
                    entry = data[prompt_id]
                    status = entry.get("status", {})
                    if status.get("completed"):
                        log_line("agent", "✅", "COMFYUI", f"Generation complete: {prompt_id}")
                        return entry
                    if status.get("status_str") == "error":
                        err_msgs = status.get("messages") or []
                        # Extract meaningful error details from execution_error messages
                        error_detail = ""
                        for msg in err_msgs:
                            if isinstance(msg, (list, tuple)) and len(msg) >= 2 and msg[0] == "execution_error":
                                info = msg[1] if isinstance(msg[1], dict) else {}
                                node_type = info.get("node_type", "?")
                                exc_msg = info.get("exception_message", "").strip()
                                exc_type = info.get("exception_type", "")
                                error_detail = f"{node_type}: {exc_type}: {exc_msg}"
                                break
                        if not error_detail:
                            error_detail = str(err_msgs)[:500]
                        log_line("error", "⚠️", "COMFYUI", f"Execution error: {error_detail}")
                        raise RuntimeError(f"ComfyUI generation failed: {error_detail}")
            except httpx.HTTPStatusError:
                pass  # not ready yet
            await asyncio.sleep(poll_interval)

    raise TimeoutError(f"ComfyUI generation timed out after {timeout}s for prompt_id={prompt_id}")


async def download_image(filename: str, subfolder: str = "", img_type: str = "output") -> str:
    """Download a generated image from ComfyUI and save it locally.
    Returns the relative URL path for serving (e.g. /static/generated/xxx.png)."""
    params = {"filename": filename, "type": img_type}
    if subfolder:
        params["subfolder"] = subfolder
    url = f"{_base_url()}/view"

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()

        # Save with a unique name to avoid collisions
        ext = os.path.splitext(filename)[1] or ".png"
        local_name = f"{uuid.uuid4().hex[:12]}{ext}"
        local_path = os.path.join(GENERATED_DIR, local_name)
        with open(local_path, "wb") as f:
            f.write(resp.content)

        relative_url = f"/static/generated/{local_name}"
        log_line("agent", "💾", "COMFYUI", f"Saved image: {relative_url}")
        return relative_url


def _extract_images_from_history(entry: Dict[str, Any]) -> list:
    """Extract image filenames from the history entry outputs."""
    images = []
    outputs = entry.get("outputs") or {}
    for node_id, node_output in outputs.items():
        if "images" in node_output:
            for img in node_output["images"]:
                images.append({
                    "filename": img.get("filename", ""),
                    "subfolder": img.get("subfolder", ""),
                    "type": img.get("type", "output"),
                })
    return images


# ---------------------------------------------------------------------------
# High-level: generate an image from a text prompt
# ---------------------------------------------------------------------------

async def generate_image(
    prompt: str,
    negative_prompt: str = "",
    checkpoint: str = "",
    steps: int = 0,
    cfg_scale: float = 0,
    width: int = 0,
    height: int = 0,
    sampler: str = "",
    scheduler: str = "",
    seed: int = -1,
) -> Tuple[str, Dict[str, Any]]:
    """
    Generate an image via ComfyUI txt2img.
    Returns (image_url, metadata_dict).
    """
    if not is_enabled():
        raise RuntimeError("ComfyUI is not enabled. Configure it in Settings → ComfyUI.")

    workflow = await _build_txt2img_workflow(
        prompt=prompt,
        negative_prompt=negative_prompt,
        checkpoint=checkpoint,
        steps=steps,
        cfg_scale=cfg_scale,
        width=width,
        height=height,
        sampler=sampler,
        scheduler=scheduler,
        seed=seed,
    )

    prompt_id = await queue_prompt(workflow)
    entry = await poll_until_done(prompt_id)
    images = _extract_images_from_history(entry)

    if not images:
        raise RuntimeError("ComfyUI returned no images — check workflow or ComfyUI logs.")

    # Download the first image
    img = images[0]
    image_url = await download_image(
        filename=img["filename"],
        subfolder=img["subfolder"],
        img_type=img["type"],
    )

    metadata = {
        "prompt_id": prompt_id,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "image_url": image_url,
        "filename": img["filename"],
    }
    return image_url, metadata


# ---------------------------------------------------------------------------
# Test connection
# ---------------------------------------------------------------------------

async def test_connection(override_url: str = None) -> Dict[str, Any]:
    """Test the ComfyUI connection and return system info."""
    base = (override_url or _base_url()).rstrip("/")
    url = f"{base}/system_stats"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            return {"ok": True, "system_stats": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def get_checkpoints(override_url: str = None) -> list:
    """Fetch available checkpoint model names from ComfyUI."""
    base = (override_url or _base_url()).rstrip("/")
    url = f"{base}/object_info/CheckpointLoaderSimple"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            inputs = data.get("CheckpointLoaderSimple", {}).get("input", {}).get("required", {})
            ckpt_list = inputs.get("ckpt_name", [[]])[0]
            return list(ckpt_list) if isinstance(ckpt_list, (list, tuple)) else []
    except Exception as e:
        log_line("error", "⚠️", "COMFYUI", f"Failed to fetch checkpoints: {e}")
        return []


async def get_samplers(override_url: str = None) -> Dict[str, list]:
    """Fetch available sampler and scheduler names from ComfyUI."""
    base = (override_url or _base_url()).rstrip("/")
    url = f"{base}/object_info/KSampler"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            inputs = data.get("KSampler", {}).get("input", {}).get("required", {})
            samplers = inputs.get("sampler_name", [[]])[0]
            schedulers = inputs.get("scheduler", [[]])[0]
            return {
                "samplers": list(samplers) if isinstance(samplers, (list, tuple)) else [],
                "schedulers": list(schedulers) if isinstance(schedulers, (list, tuple)) else [],
            }
    except Exception as e:
        log_line("error", "⚠️", "COMFYUI", f"Failed to fetch samplers: {e}")
        return {"samplers": [], "schedulers": []}

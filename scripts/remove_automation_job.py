#!/usr/bin/env python3
"""
Șterge un job de automatizare din jobs.sqlite și scheduler_meta.sqlite.
Folosire: oprește serverul, rulează:
  python scripts/remove_automation_job.py [job_id]
  python scripts/remove_automation_job.py --list   # listează toate automatizările
  python scripts/remove_automation_job.py --symbol AAPL   # șterge toate cu symbol AAPL

Exemple job_id: auto_web_d1523cba_1771280284_8ea4089c
"""
import os
import sys
import sqlite3
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS_DB = os.path.join(ROOT, "jobs.sqlite")
META_DB = os.path.join(ROOT, "scheduler_meta.sqlite")


def list_automations():
    if not os.path.isfile(META_DB):
        print("scheduler_meta.sqlite nu există.")
        return
    conn = sqlite3.connect(META_DB)
    rows = conn.execute("SELECT job_id, spec_json FROM automation_specs").fetchall()
    conn.close()
    if not rows:
        print("Nicio automatizare în automation_specs.")
        return
    print("Automatizări în scheduler_meta.sqlite:")
    for job_id, spec_json in rows:
        try:
            spec = json.loads(spec_json)
            msg = spec.get("display_message") or spec.get("skill_name") or job_id
            uid = spec.get("user_id", "")
            print(f"  {job_id}")
            print(f"    user_id={uid}, display_message={msg}")
            if spec.get("skill_input"):
                print(f"    skill_input={spec['skill_input']}")
        except Exception:
            print(f"  {job_id} (spec invalid)")
    print("\nPentru a șterge: python scripts/remove_automation_job.py <job_id>")


def remove_job(job_id: str):
    job_id = (job_id or "").strip()
    if not job_id.startswith("auto_"):
        print("job_id trebuie să înceapă cu auto_")
        return False
    removed_meta = False
    removed_jobs = False
    if os.path.isfile(META_DB):
        conn = sqlite3.connect(META_DB)
        cur = conn.execute("DELETE FROM automation_specs WHERE job_id = ?", (job_id,))
        removed_meta = cur.rowcount > 0
        conn.commit()
        conn.close()
    if os.path.isfile(JOBS_DB):
        conn = sqlite3.connect(JOBS_DB)
        cur = conn.execute("DELETE FROM apscheduler_jobs WHERE id = ?", (job_id,))
        removed_jobs = cur.rowcount > 0
        conn.commit()
        conn.close()
    print(f"Spec (scheduler_meta): {'șters' if removed_meta else 'nu exista'}")
    print(f"Job (jobs.sqlite): {'șters' if removed_jobs else 'nu exista'}")
    return removed_meta or removed_jobs


def remove_by_symbol(symbol: str):
    if not os.path.isfile(META_DB):
        print("scheduler_meta.sqlite nu există.")
        return
    conn = sqlite3.connect(META_DB)
    rows = conn.execute("SELECT job_id, spec_json FROM automation_specs").fetchall()
    conn.close()
    to_remove = []
    for job_id, spec_json in rows:
        try:
            spec = json.loads(spec_json)
            if (spec.get("skill_input") or {}).get("symbol") == symbol:
                to_remove.append(job_id)
        except Exception:
            pass
    if not to_remove:
        print(f"Niciun job cu symbol={symbol}.")
        return
    for jid in to_remove:
        print(f"Șterg {jid} ...")
        remove_job(jid)
    print(f"Gata. Șterse {len(to_remove)} job-uri cu symbol={symbol}.")


def main():
    os.chdir(ROOT)
    if not sys.argv[1:]:
        print("Folosire: remove_automation_job.py --list | --symbol SYMBOL | <job_id>")
        return
    arg = sys.argv[1].strip()
    if arg == "--list":
        list_automations()
        return
    if arg == "--symbol" and len(sys.argv) > 2:
        remove_by_symbol(sys.argv[2].strip())
        return
    remove_job(arg)


if __name__ == "__main__":
    main()

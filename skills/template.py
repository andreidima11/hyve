"""
Șablon obligatoriu pentru skill-uri Memini (inclusiv cele generate de Forge).

Contract:
- Clasă cu nume Skill (sau numele modulului în PascalCase).
- Metodă execute(input: dict) -> dict.
- input: dict cu chei cerute de skill (ex: "query", "user_id"); întotdeauna string values.
- return: dict cu cel puțin "success": bool și "message" sau "result"; poate conține "data".
- Nu folosi I/O extern (file, network) decât dacă e esențial; preferă logică pură.
"""
from typing import Dict, Any


class Skill:
    """Exemplu de skill. Înlocuiește docstring-ul și logica cu cerința userului."""

    name = "example"
    description = "Skill exemplu care returnează un salut."

    @staticmethod
    def execute(input_data: Dict[str, Any]) -> Dict[str, Any]:
        name = (input_data or {}).get("name", "world")
        return {
            "success": True,
            "message": f"Hello, {name}!",
            "data": {},
        }

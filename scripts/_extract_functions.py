import marshal, types, dis

with open('routers/__pycache__/automations_reminders.cpython-312.pyc', 'rb') as f:
    f.read(16)
    code = marshal.load(f)

def get_nested(co, name):
    for c in co.co_consts:
        if isinstance(c, types.CodeType) and c.co_name == name:
            return c
    return None

# Disassemble specific functions we need to reconstruct
funcs = [
    '_owner_id_for_user', '_actor_for_user', 'list_reminders', 'delete_reminder',
    'ReminderBulkDelete', 'bulk_delete_reminders', 'AutomationCreate', 'create_automation',
    'ReminderUpdate', 'update_reminder',
    'AutomationDefinitionValidateBody', 'AutomationDefinitionCreateBody',
    'AutomationDefinitionReplaceBody', 'AutomationDefinitionToggleBody',
    'validate_automation_definition', 'list_automation_definitions',
    'create_automation_definition', 'get_automation_definition',
    'replace_automation_definition', 'enable_automation_definition',
    'disable_automation_definition', 'run_automation_definition',
    'get_automation_definition_history', 'delete_automation_definition'
]

for fname in funcs:
    co = get_nested(code, fname)
    if co:
        print(f"\n{'='*60}")
        print(f"FUNCTION: {fname} (line {co.co_firstlineno})")
        print(f"  args: {co.co_varnames[:co.co_argcount]}")
        print(f"  locals: {co.co_varnames}")
        print(f"  names: {co.co_names}")
        print(f"{'='*60}")
        dis.dis(co)

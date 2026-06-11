import marshal, struct, dis, types

with open('routers/__pycache__/automations_reminders.cpython-312.pyc', 'rb') as f:
    f.read(16)
    code = marshal.load(f)

def print_code_obj(co, name="<module>", indent=0):
    prefix = "  " * indent
    print(f"{prefix}=== {name} (line {co.co_firstlineno}) ===")
    print(f"{prefix}  args: {co.co_varnames[:co.co_argcount]}")
    print(f"{prefix}  locals: {co.co_varnames}")
    for c in co.co_consts:
        if isinstance(c, str) and c.strip():
            print(f"{prefix}  CONST: {repr(c[:300])}")
        elif isinstance(c, (int, float, bool, type(None))):
            pass
        elif isinstance(c, tuple):
            str_items = [x for x in c if isinstance(x, str)]
            if str_items:
                print(f"{prefix}  TUPLE_CONST: {str_items}")
    for c in co.co_consts:
        if isinstance(c, types.CodeType):
            print_code_obj(c, c.co_name, indent+1)

print_code_obj(code)
print("\n\n=== FULL DISASSEMBLY ===\n")
dis.dis(code)

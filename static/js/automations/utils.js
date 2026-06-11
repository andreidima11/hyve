export function errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
export function inputVal(el) {
    return String(el?.value ?? '');
}
export function autoEl(id) {
    return document.getElementById(id);
}

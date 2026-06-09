/**
 * Strip thinking tags from streamed assistant content.
 */

export function stripThinkFromContent(text: unknown): string {
    if (!text || typeof text !== 'string') return (text as string) || '';
    let s = text;
    const thinkBlockRe = new RegExp('<think>[\\s\\S]*?<\\/think>', 'gi');
    const thinkingBlockRe = new RegExp('<thinking>[\\s\\S]*?<\\/thinking>', 'gi');
    s = s.replace(thinkBlockRe, '');
    s = s.replace(thinkingBlockRe, '');
    s = s.replace(/\s*<\/think>\s*|\s*<\/thinking>\s*/gi, ' ');
    s = s.replace(/\s*<think>\s*|\s*<thinking>\s*/gi, ' ');
    return s.replace(/\s{3,}/g, ' ').trim();
}

export function contentAfterThink(text: unknown): string {
    if (!text || typeof text !== 'string') return (text as string) || '';
    const closeTags = ['</think>', '</thinking>'];
    let best = -1;
    let tagLen = 0;
    const lower = text.toLowerCase();
    for (const tag of closeTags) {
        const i = lower.lastIndexOf(tag.toLowerCase());
        if (i >= 0 && (best < 0 || i > best)) { best = i; tagLen = tag.length; }
    }
    if (best < 0) return '';
    return text.slice(best + tagLen).trim();
}

export function splitThinkingFromReply(
    text: string,
): { thinking: string; reply: string } | null {
    if (!text || text.length < 80) return null;
    const replyStarters = /(?:\.|\n)\s*(Uite|Iată|So,|Well,|Here'?s?|I'm |Deci,|Așadar,|În concluzie,|Pe scurt,)/gi;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = replyStarters.exec(text)) !== null) lastMatch = m;
    if (lastMatch && lastMatch.index >= 50) {
        const replyStart = lastMatch.index + lastMatch[0].length - lastMatch[1].length;
        const thinking = text.slice(0, replyStart).trim();
        const reply = text.slice(replyStart).trim();
        if (reply.length > 0 && thinking.length >= 50) return { thinking, reply };
    }
    const segments = text.split(/\n\n+/);
    const starterRe = /^\s*(Uite|Iată|So,|Well,|Here'?s?|I'm |Deci,|Așadar,)/i;
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i].trim();
        if (starterRe.test(seg) && seg.length < 600) {
            const thinking = segments.slice(0, i).join('\n\n').trim();
            const reply = segments.slice(i).join('\n\n').trim();
            if (thinking.length >= 60) return { thinking, reply };
        }
    }
    return null;
}

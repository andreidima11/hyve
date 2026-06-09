/**
 * Marked.js renderer configuration for chat markdown.
 */

import { imgProxyUrlSync } from '../camera_auth.js';

interface MarkedToken {
    href?: string;
    title?: string;
    text?: string;
    align?: string;
    header?: Array<{ text?: string; align?: string }>;
    rows?: Array<Array<{ text?: string; align?: string }>>;
}

if (typeof marked !== 'undefined') {
    marked.use({
        breaks: true,
        gfm: true,
        renderer: {
            link({ href, title, text }: MarkedToken) {
                const titleAttr = title ? ` title="${title}"` : '';
                const displayText = text || href;
                return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}</a>`;
            },
            table({ header, rows }: MarkedToken) {
                let headerHtml = '';
                let bodyHtml = '';
                if (header && header.length) {
                    headerHtml = '<thead><tr>' + header.map((cell) => {
                        const align = cell.align ? ` style="text-align:${cell.align}"` : '';
                        return `<th${align}>${cell.text || ''}</th>`;
                    }).join('') + '</tr></thead>';
                }
                if (rows && rows.length) {
                    bodyHtml = '<tbody>' + rows.map((row) => {
                        return '<tr>' + row.map((cell) => {
                            const align = cell.align ? ` style="text-align:${cell.align}"` : '';
                            return `<td${align}>${cell.text || ''}</td>`;
                        }).join('') + '</tr>';
                    }).join('') + '</tbody>';
                }
                return `<div class="chat-table-wrap"><table>${headerHtml}${bodyHtml}</table></div>`;
            },
            blockquote({ text }: MarkedToken) {
                return `<blockquote class="chat-blockquote">${text || ''}</blockquote>\n`;
            },
            image({ href, title, text }: MarkedToken) {
                let src = href || '';
                if (/^https?:\/\//i.test(src)) {
                    src = imgProxyUrlSync(src);
                }
                const titleAttr = title ? ` title="${title}"` : '';
                const altAttr = text ? ` alt="${text}"` : ' alt=""';
                return `<img src="${src}"${altAttr}${titleAttr} class="chat-md-image" loading="lazy">`;
            },
        },
    });
}

export {};
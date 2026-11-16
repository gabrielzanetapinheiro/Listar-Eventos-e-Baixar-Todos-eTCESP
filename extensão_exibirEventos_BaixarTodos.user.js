// ==UserScript==
// @name         E-TCESP - Evento + Baixar Todos
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Exibe (ev. X.Y) antes do nome do arquivo e adiciona botão para baixar todos numa pasta com o número do processo. Despachos (.html) e publicações (.lnk) são salvos com o CONTEÚDO, não com o link.
// @author       Gabriel Zaneta Pinheiro
// @match        https://e-processo.tce.sp.gov.br/*
// @noframes     true
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      e-processo.tce.sp.gov.br
// @connect      do.tce.sp.gov.br
// @connect      tce.sp.gov.br
// @connect      self
// @connect      *
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/gabrielzanetapinheiro/Listar-Eventos-e-Baixar-Todos-eTCESP/main/extens%C3%A3o_exibirEventos_BaixarTodos.user.js
// @updateURL    https://raw.githubusercontent.com/gabrielzanetapinheiro/Listar-Eventos-e-Baixar-Todos-eTCESP/main/extens%C3%A3o_exibirEventos_BaixarTodos.user.js
// ==/UserScript==

(function () {
    'use strict';
    var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    var scriptCode = '(' + function () {
        'use strict';
        if (window.__tceComboInit) return;
        window.__tceComboInit = true;

        var EVENT_RE = /^\d+\.\d+$/;
        var observer = null;
        var heartbeat = null;
        var lastState = '';
        var downloading = false;
        var retryItems = null;
        var HEARTBEAT_MS = 5000;

        function pauseBackground() {
            try { if (observer) observer.disconnect(); } catch (e) {}
            try { if (heartbeat) clearInterval(heartbeat); } catch (e) {}
            heartbeat = null;
        }
        function resumeBackground() {
            try { if (observer) observer.observe(document, { childList: true, subtree: true }); } catch (e) {}
            if (!heartbeat) heartbeat = setInterval(run, HEARTBEAT_MS);
        }
        function log(msg) {
            try { console.log('[E-TCESP v1.7] ' + msg); } catch (e) {}
        }

        // ── MÁSCARA DE EVENTOS ──
        function showEventNumbers() {
            if (!document.body) return 0;
            var added = 0;
            var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT, null, false);
            var node;
            while (node = walker.nextNode()) {
                var text = node.textContent.trim();
                if (!EVENT_RE.test(text)) continue;
                var host = node.parentElement;
                if (!host) continue;
                var tr = host.closest('tr');
                if (!tr) continue;
                var fileLink = tr.querySelector('a[href*="DownloadArquivo"]');
                if (!fileLink) continue;
                if (fileLink.parentElement.querySelector('.evt-num')) continue;
                var span = document.createElement('span');
                span.className = 'evt-num';
                span.textContent = '(ev. ' + text + ') | ';
                span.style.cssText = 'font-weight:bold;color:#1a5276;font-size:12px;';
                span.style.setProperty('display', 'inline', 'important');
                fileLink.insertAdjacentElement('beforebegin', span);
                added++;
            }
            return added;
        }

        function enforceMaskVisibility() {
            var masks = document.querySelectorAll('.evt-num');
            for (var i = 0; i < masks.length; i++) {
                if (masks[i].style.display !== 'inline') {
                    masks[i].style.setProperty('display', 'inline', 'important');
                }
            }
            return masks.length;
        }

        function getEvNum(linkEl) {
            var tr = linkEl.closest('tr');
            if (!tr) return '';
            var w = document.createTreeWalker(tr, NodeFilter.SHOW_COMMENT, null, false);
            var n;
            while (n = w.nextNode()) {
                var t = n.textContent.trim();
                if (EVENT_RE.test(t)) return t;
            }
            return '';
        }

        function sanitizeFileName(name) {
            var clean = (name || 'arquivo')
                .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
                .replace(/\s+/g, ' ')
                .trim();
            if (!clean) return 'arquivo';
            if (clean.length <= 180) return clean;
            var dot = clean.lastIndexOf('.');
            var ext = (dot > 0 && clean.length - dot <= 12) ? clean.slice(dot) : '';
            return (clean.slice(0, 180 - ext.length).trim() + ext) || 'arquivo';
        }

        // ── NÚMERO DO PROCESSO (pasta de destino) ──
        function collectFrames(win, out) {
            try { out.push(win); } catch (e) { return; }
            var n = 0;
            try { n = win.frames.length; } catch (e) { return; }
            for (var i = 0; i < n; i++) {
                try { collectFrames(win.frames[i], out); } catch (e) {}
            }
        }

        function readProcAnchor(doc) {
            try {
                var a = doc.querySelector('td.numProcesso a, a[href*="DadosProcesso?numeroProcesso="]');
                if (!a) return null;
                var canon = '';
                var m = (a.getAttribute('href') || '').match(/numeroProcesso=(\d+)/);
                if (m) canon = m[1];
                var text = (a.textContent || '').trim();
                if (!canon && !/\d+\.\d{3}\.\d{2}/.test(text)) return null;
                return { canon: canon, text: text };
            } catch (e) { return null; }
        }

        function findProcInfo() {
            var got = readProcAnchor(document);
            if (got) return got;
            var wins = [];
            try { if (window.top) collectFrames(window.top, wins); } catch (e) {}
            for (var i = 0; i < wins.length; i++) {
                try {
                    var doc = wins[i].document;
                    if (!doc) continue;
                    var r = readProcAnchor(doc);
                    if (r) return r;
                } catch (e) {}
            }
            return null;
        }

        function first6(seg) {
            var v = String(parseInt(seg, 10));
            if (v === 'NaN') v = '0';
            return v.length >= 6 ? v : ('000000' + v).slice(-6);
        }

        function formatFromCanon(c) {
            if (!/^\d{7,}$/.test(c)) return null;
            var first = c.slice(0, -6);
            var tail  = c.slice(-6);
            return first6(first) + '.' + tail.slice(0, 3) + '.' + tail.slice(3, 5) + '-' + tail.slice(5);
        }

        function formatFromText(t) {
            var m = (t || '').match(/(\d+)\.(\d{3})\.(\d{2})(?:-(\d+))?/);
            if (!m) return null;
            return first6(m[1]) + '.' + m[2] + '.' + m[3] + (m[4] ? '-' + m[4] : '');
        }

        function getProcessFolder() {
            var info = findProcInfo();
            if (!info) return null;
            var f = (info.canon && formatFromCanon(info.canon)) || formatFromText(info.text);
            return (f && /^\d[\d.\-]*$/.test(f)) ? f : null;
        }

        function findNavLink() {
            var list = document.querySelectorAll('a.btAtividade');
            for (var i = 0; i < list.length; i++) {
                if (list[i].textContent.indexOf('Navegar') > -1) return list[i];
            }
            return null;
        }

        // ── BOTÃO BAIXAR TODOS ──
        function addDownloadButton() {
            var navLink = findNavLink();
            if (!navLink) return false;
            var existing = document.getElementById('tce-dl-btn');
            if (existing) {
                if (existing.isConnected) return false;
                existing.remove();
            }
            var btn = document.createElement('a');
            btn.id = 'tce-dl-btn';
            btn.href = 'javascript:void(0);';
            btn.className = 'btAtividade linkBt';
            btn.textContent = 'Baixar Todos os Arquivos';
            btn.style.cssText = 'margin-left:10px;background:#1a5276;color:#fff;padding:4px 14px;text-decoration:none;font-weight:bold;font-size:12px;border-radius:4px;cursor:pointer;';
            navLink.parentElement.appendChild(document.createTextNode(' '));
            navLink.parentElement.appendChild(btn);
            btn.addEventListener('click', function (e) { onDownloadClick(btn, e); });
            return true;
        }

        // NOVO (v1.7): nada é mais ignorado. PDF é baixado direto; todo o resto
        // (despachos .html, publicações .lnk etc.) é marcado como "extract": o
        // host busca o conteúdo real (seguindo redirecionamentos) e salva o
        // documento em si, não o atalho.
        function collectFiles() {
            var out = [];
            var seen = {};
            document.querySelectorAll('a[href*="DownloadArquivo"]').forEach(function (a) {
                var name = a.textContent.trim();
                var lower = name.toLowerCase();
                var kind = /\.pdf$/.test(lower) ? 'direct' : 'extract';
                var ev = getEvNum(a);
                var finalName = sanitizeFileName(ev ? '(ev. ' + ev + ') ' + name : name);
                // evita nomes repetidos (ex.: vários "online.html" no mesmo evento)
                var key = finalName.toLowerCase();
                if (seen[key]) {
                    seen[key]++;
                    var dot = finalName.lastIndexOf('.');
                    finalName = dot > 0
                        ? finalName.slice(0, dot) + ' (' + seen[key] + ')' + finalName.slice(dot)
                        : finalName + ' (' + seen[key] + ')';
                } else {
                    seen[key] = 1;
                }
                out.push({ url: a.href, name: finalName, kind: kind });
            });
            return out;
        }

        function resetButtonLater(btn, ms) {
            setTimeout(function () {
                if (retryItems && retryItems.length) return;
                btn.textContent = 'Baixar Todos os Arquivos';
                btn.style.background = '#1a5276';
            }, ms);
        }

        function startBatch(items, btn) {
            var batchId = 'b' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
            var noReply;
            function cleanup() {
                clearTimeout(noReply);
                window.removeEventListener('message', onMsg);
                downloading = false;
                btn.dataset.busy = '';
                resumeBackground();
                run();
            }
            function onMsg(ev) {
                var d = ev.data;
                if (!d || d.__tce !== 1 || d.batchId !== batchId) return;
                clearTimeout(noReply);
                noReply = setTimeout(onNoReply, 30000);
                if (d.type === 'progress') {
                    btn.textContent = 'Baixando ' + d.done + '/' + d.total +
                                      (d.failures ? ' (' + d.failures + ' falha)' : '') +
                                      (d.limitado ? ' [ritmo reduzido]' : '') + '...';
                    btn.style.background = '#78350f';
                } else if (d.type === 'config') {
                    cleanup();
                    retryItems = items;
                    alert('O Tampermonkey precisa de permissão para baixar arquivos.\n\n' +
                          'Abra o painel da extensão Tampermonkey → Configurações →\n' +
                          'Downloads e habilite o modo de download do navegador.\n' +
                          'Para salvar na pasta do processo, habilite também as\n' +
                          'subpastas ("Subdirectory"/"Subdiretório").\n\n' +
                          'Depois clique novamente no botão para repetir.');
                    btn.textContent = 'Habilite downloads no Tampermonkey e repita';
                    btn.style.background = '#92400e';
                    resetButtonLater(btn, 8000);
                } else if (d.type === 'done') {
                    cleanup();
                    var fails = d.failures || [];
                    var soltos = d.fallbacks || [];
                    retryItems = fails.length ? fails : null;
                    if (soltos.length) {
                        log(soltos.length + ' documento(s) salvos na raiz de Downloads (fora da pasta): ' + soltos.join(' | '));
                        alert(soltos.length + ' documento(s) .html foram salvos direto na pasta Downloads,\n' +
                              'fora da subpasta do processo, porque o Tampermonkey recusou o .html.\n\n' +
                              'Para que fiquem na subpasta: Tampermonkey → Configurações →\n' +
                              'Downloads → "Extensões de arquivo na lista branca" e inclua: html');
                    }
                    if (fails.length) {
                        log('falharam ' + fails.length + ' arquivo(s): ' +
                            fails.map(function (f) { return f.name; }).join(' | '));
                        btn.textContent = fails.length + ' falha(s) — clique p/ repetir';
                        btn.style.background = '#92400e';
                    } else {
                        btn.textContent = 'Concluído!';
                        btn.style.background = '#065f46';
                        resetButtonLater(btn, 4000);
                    }
                }
            }
            function onNoReply() {
                cleanup();
                alert('O download não respondeu. Recarregue a página e tente de novo.\n' +
                      '(Se persistir, confirme que o userscript está ativo nesta aba.)');
                btn.textContent = 'Sem resposta — recarregue e repita';
                btn.style.background = '#92400e';
                resetButtonLater(btn, 6000);
            }
            window.addEventListener('message', onMsg);
            noReply = setTimeout(onNoReply, 30000);
            btn.textContent = 'Baixando 0/' + items.length + '...';
            btn.style.background = '#78350f';
            (window.top || window).postMessage(
                { __tceReq: 1, batchId: batchId, folder: getProcessFolder() || '', items: items }, '*');
        }

        function onDownloadClick(btn, e) {
            e.preventDefault();
            if (downloading || btn.dataset.busy === '1') return;

            if (retryItems && retryItems.length) {
                var again = retryItems;
                retryItems = null;
                downloading = true;
                pauseBackground();
                btn.dataset.busy = '1';
                startBatch(again, btn);
                return;
            }

            downloading = true;
            pauseBackground();

            var expanded = [];
            document.querySelectorAll('span[id^="subMostra"]').forEach(function (s) {
                expanded.push({ el: s, prev: s.style.display });
                s.style.display = 'block';
            });
            function restore() {
                for (var i = 0; i < expanded.length; i++) {
                    try { expanded[i].el.style.display = expanded[i].prev; } catch (e) {}
                }
                try { showEventNumbers(); enforceMaskVisibility(); } catch (e) {}
            }

            setTimeout(function () {
                var items = collectFiles();
                restore();
                if (!items.length) {
                    downloading = false; resumeBackground();
                    alert('Nenhum arquivo encontrado.');
                    return;
                }
                var nPdf = items.filter(function (i) { return i.kind === 'direct'; }).length;
                var nExt = items.length - nPdf;
                var folder = getProcessFolder();
                var msg = 'Baixar ' + items.length + ' arquivo(s)?\n' +
                          '  • ' + nPdf + ' PDF(s)\n' +
                          '  • ' + nExt + ' documento(s) com conteúdo extraído\n' +
                          '    (despachos .html e publicações .lnk → salvos como .html)\n\n' +
                          (folder
                              ? 'Pasta de destino (dentro de Downloads):\n    ' + folder
                              : 'Número do processo não encontrado — os arquivos vão\n' +
                                'direto para a raiz da pasta Downloads.');
                if (!confirm(msg)) {
                    downloading = false; resumeBackground();
                    run();
                    return;
                }
                btn.dataset.busy = '1';
                startBatch(items, btn);
            }, 600);
        }

        // ── EXECUÇÃO IDEMPOTENTE ──
        function run() {
            try {
                var addedMasks = showEventNumbers();
                enforceMaskVisibility();
                if (downloading) return;

                var addedBtn = addDownloadButton();
                var masks = document.querySelectorAll('.evt-num').length;
                var hasBtn = !!document.getElementById('tce-dl-btn');
                var state = masks + '|' + hasBtn;
                if (state !== lastState && (addedMasks > 0 || addedBtn)) {
                    lastState = state;
                    log('aplicado: ' + masks + ' máscara(s), botão=' + hasBtn);
                }
            } catch (e) { log('erro: ' + (e && e.message)); }
        }

        var scheduled = false;
        function schedule() {
            if (scheduled) return;
            scheduled = true;
            setTimeout(function () { scheduled = false; run(); }, 150);
        }

        log('iniciado (' + (window.self === window.top ? 'topo' : 'frame') + ') ' + location.pathname);
        run();

        observer = new MutationObserver(schedule);
        try { observer.observe(document, { childList: true, subtree: true }); } catch (e) {}

        [300, 900, 2000].forEach(function (t) { setTimeout(run, t); });

        heartbeat = setInterval(run, HEARTBEAT_MS);

        window.addEventListener('pagehide', function () {
            try { observer.disconnect(); } catch (e) {}
            try { clearInterval(heartbeat); } catch (e) {}
        }, { once: true });
    } + ')();';

    function injectIntoFrame(win) {
        try {
            if (!win || win.__tceCombo) return;
            var doc = win.document;
            if (!doc || (!doc.body && !doc.documentElement)) return;
            win.__tceCombo = true;
            var s = doc.createElement('script');
            s.textContent = scriptCode;
            (doc.body || doc.documentElement).appendChild(s);
            if (s.parentNode) s.parentNode.removeChild(s);
        } catch (e) {}
    }

    function scanWin(win, depth) {
        if (!win || depth > 6) return;
        injectIntoFrame(win);
        var n = 0;
        try { n = win.frames.length; } catch (e) { return; }
        for (var i = 0; i < n; i++) {
            try { scanWin(win.frames[i], depth + 1); } catch (e) {}
        }
    }
    function scan() { scanWin(W, 0); }

    // ════════════════════════════════════════════════════════════════════
    // EXTRAÇÃO DE CONTEÚDO (v1.7)
    // Os despachos "online.html" vêm em ISO-8859-1 com imagens relativas, e os
    // ".lnk" ("Disponibilização DOE") são só um redirecionamento para o Diário
    // Oficial (do.tce.sp.gov.br). Aqui buscamos o documento final com
    // GM_xmlhttpRequest (que segue o redirecionamento e passa por CORS),
    // decodificamos no charset certo, embutimos CSS e imagens e salvamos um
    // .html autossuficiente em UTF-8, que abre offline.
    // ════════════════════════════════════════════════════════════════════
    function gmGet(url, timeout) {
        return new Promise(function (resolve, reject) {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'arraybuffer',
                    timeout: timeout || DL_TIMEOUT,
                    onload: function (r) {
                        if (r.status >= 500) return reject('server_error');
                        if (r.status >= 400 || r.status === 0) return reject('http_' + r.status);
                        resolve(r);
                    },
                    onerror: function () { reject('network'); },
                    ontimeout: function () { reject('timeout'); },
                    onabort: function () { reject('network'); }
                });
            } catch (e) { reject('fatal'); }
        });
    }

    function headerValue(r, name) {
        var re = new RegExp('^' + name + ':\\s*(.*)$', 'im');
        var m = re.exec(r.responseHeaders || '');
        return m ? m[1].trim() : '';
    }

    function normCharset(c) {
        c = (c || '').toLowerCase().replace(/["']/g, '').trim();
        if (!c || c === 'iso-8859-1' || c === 'latin1' || c === 'latin-1' || c === 'us-ascii' || c === 'ascii') return 'windows-1252';
        return c;
    }

    function latinHead(buf, n) {
        return new TextDecoder('windows-1252').decode(new Uint8Array(buf).subarray(0, n));
    }

    function decodeText(buf, ct) {
        var cs;
        var m = /charset=([^;\s]+)/i.exec(ct || '');
        if (m) cs = normCharset(m[1]);
        else {
            m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(latinHead(buf, 4096));
            cs = m ? normCharset(m[1]) : 'windows-1252';
        }
        try { return new TextDecoder(cs).decode(buf); }
        catch (e) { return new TextDecoder('windows-1252').decode(buf); }
    }

    function looksHtml(ct, buf) {
        if (/html/i.test(ct)) return true;
        if (ct && !/text\/plain|octet-stream|x-download|force-download/i.test(ct)) return false;
        return /<!doctype html|<html|<body|<table|<div|<p[\s>]/i.test(latinHead(buf, 2048));
    }

    function toBase64(buf) {
        var b = new Uint8Array(buf), s = '', CH = 0x8000;
        for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
        return btoa(s);
    }

    function absUrl(u, base) {
        try { return new URL(u, base).href; } catch (e) { return u; }
    }

    function absolutizeCss(css, base) {
        return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (all, q, u) {
            if (/^(data:|#)/i.test(u)) return all;
            return 'url("' + absUrl(u, base) + '")';
        });
    }

    function makeExtractor() {
        var imgCache = {};
        function imgToData(url) {
            if (!imgCache[url]) {
                imgCache[url] = gmGet(url, 30000).then(function (r) {
                    var ct = (headerValue(r, 'content-type').split(';')[0] || 'image/png').trim();
                    return 'data:' + ct + ';base64,' + toBase64(r.response);
                }, function () { return url; });
            }
            return imgCache[url];
        }

        async function buildHtml(html, baseUrl) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var rm = function (sel) {
                Array.prototype.slice.call(doc.querySelectorAll(sel)).forEach(function (n) { n.remove(); });
            };
            rm('script, noscript, base, meta[http-equiv], meta[charset], iframe[src*="DownloadArquivo"]');

            var head = doc.head;
            if (!head) { head = doc.createElement('head'); doc.documentElement.insertBefore(head, doc.body); }
            var meta = doc.createElement('meta');
            meta.setAttribute('charset', 'utf-8');
            head.insertBefore(meta, head.firstChild);

            // CSS externo → <style> embutido
            var links = Array.prototype.slice.call(doc.querySelectorAll('link[rel~="stylesheet"][href]'));
            for (var i = 0; i < links.length; i++) {
                var href = absUrl(links[i].getAttribute('href'), baseUrl);
                try {
                    var r = await gmGet(href, 30000);
                    var st = doc.createElement('style');
                    st.textContent = absolutizeCss(decodeText(r.response, headerValue(r, 'content-type')), href);
                    links[i].replaceWith(st);
                } catch (e) { links[i].setAttribute('href', href); }
            }

            // imagens → data URI (abre offline)
            var imgs = Array.prototype.slice.call(doc.querySelectorAll('img[src]'));
            for (var j = 0; j < imgs.length; j++) {
                var src = imgs[j].getAttribute('src') || '';
                if (/^data:/i.test(src)) continue;
                imgs[j].setAttribute('src', await imgToData(absUrl(src, baseUrl)));
            }

            // links → absolutos; remove handlers inline
            Array.prototype.slice.call(doc.querySelectorAll('*')).forEach(function (el) {
                for (var k = el.attributes.length - 1; k >= 0; k--) {
                    if (/^on/i.test(el.attributes[k].name)) el.removeAttribute(el.attributes[k].name);
                }
                if (el.tagName === 'A' && el.hasAttribute('href')) {
                    var h = el.getAttribute('href');
                    if (!/^(#|javascript:|mailto:)/i.test(h)) el.setAttribute('href', absUrl(h, baseUrl));
                }
            });

            return '<!DOCTYPE html>\n<!-- Conteúdo extraído do e-TCESP em ' + new Date().toLocaleString('pt-BR') +
                   ' | origem: ' + String(baseUrl).replace(/--/g, '- -') + ' -->\n' +
                   doc.documentElement.outerHTML;
        }

        function htmlName(n) {
            if (/\.html?$/i.test(n)) return n;
            return n.replace(/\.(lnk|url|php|aspx?|jsp|do)$/i, '') + '.html';
        }

        return async function extract(item) {
            var r = await gmGet(item.url);
            var buf = r.response;
            if (!buf || !buf.byteLength) throw 'vazio';
            var ct = headerValue(r, 'content-type');
            var finalUrl = r.finalUrl || item.url;
            if (looksHtml(ct, buf)) {
                var html = await buildHtml(decodeText(buf, ct), finalUrl);
                return { blob: new Blob([html], { type: 'text/html;charset=utf-8' }), name: htmlName(item.name) };
            }
            // não é HTML (ex.: .doc, .xls, .zip): salva os bytes reais
            return { blob: new Blob([buf], { type: (ct.split(';')[0] || 'application/octet-stream') }), name: item.name };
        };
    }

    // Salva um Blob. Tenta GM_download (respeita a subpasta); se o Tampermonkey
    // recusar (extensão fora da lista branca, blob não suportado...), cai para
    // um <a download> comum, que salva na raiz de Downloads.
    function saveBlob(blob, name, prefix, cb) {
        var burl = URL.createObjectURL(blob);
        var done = false;
        function fin(how) {
            if (done) return; done = true;
            setTimeout(function () { try { URL.revokeObjectURL(burl); } catch (e) {} }, 120000);
            cb(how);
        }
        function fallback() {
            try {
                var a = document.createElement('a');
                a.href = burl;
                a.download = name;
                a.style.display = 'none';
                (document.body || document.documentElement).appendChild(a);
                a.click();
                a.remove();
                fin('fallback');
            } catch (e) { fin('erro'); }
        }
        try {
            GM_download({
                url: burl,
                name: prefix + name,
                saveAs: false,
                onload: function () { fin('ok'); },
                onerror: function () { fallback(); },
                ontimeout: function () { fallback(); }
            });
        } catch (e) { fallback(); }
    }

    // ── HOST DE DOWNLOAD ──
    var DL_TIMEOUT = 120000;
    var CONFIG_ERRORS = { not_enabled: 1, not_whitelisted: 1, not_permitted: 1, not_supported: 1 };
    var TRANSIENT = { timeout: 1, network: 1, server_error: 1 };

    var CONCORRENCIA_LIMITADA = 3;
    var GAP_LIMITADO_MS = 200;
    var GAP_LIMITADO_MAX_MS = 3000;

    function runDownloadBatch(items, source, batchId, folder) {
        var prefix = folder ? folder + '/' : '';
        var extract = makeExtractor();
        var pending = items.map(function (it) { return { url: it.url, name: it.name, kind: it.kind, tries: 0 }; });
        var total = pending.length;
        var done = 0, inFlight = 0;
        var failures = [];
        var fallbacks = [];
        var concurrency = total;
        var launchGap = 0, lastLaunch = 0;
        var limitado = false;
        var finished = false;

        function reply(msg) {
            msg.__tce = 1; msg.batchId = batchId;
            try { source.postMessage(msg, '*'); } catch (e) {}
        }
        function reportarProgresso() {
            reply({ type: 'progress', done: done, total: total, failures: failures.length, limitado: limitado });
        }
        function limitar(motivo) {
            if (!limitado) {
                limitado = true;
                concurrency = Math.min(CONCORRENCIA_LIMITADA, total);
                launchGap = GAP_LIMITADO_MS;
            } else {
                concurrency = Math.max(1, concurrency - 1);
                launchGap = Math.min(GAP_LIMITADO_MAX_MS, launchGap * 2);
            }
            try {
                console.log('[E-TCESP] rede reclamou (' + motivo + ') — limitando para ' +
                            concurrency + ' download(s) simultâneo(s), intervalo ' + launchGap + 'ms');
            } catch (e) {}
        }
        function settle(item, ok, kind) {
            inFlight--;
            if (ok) {
                done++;
            } else if (TRANSIENT[kind] && item.tries < 3) {
                item.tries++;
                limitar(kind);
                setTimeout(function () { pending.push(item); pump(); }, item.tries === 1 ? 2000 : 8000);
            } else {
                done++;
                if (TRANSIENT[kind]) limitar(kind);
                try { console.log('[E-TCESP] falhou (' + kind + '): ' + item.name); } catch (e) {}
                failures.push({ url: item.url, name: item.name, kind: item.kind });
            }
            reportarProgresso();
            pump();
        }

        // Despachos, .lnk e demais não-PDF: busca o conteúdo e salva o documento.
        function launchExtract(item) {
            inFlight++;
            var settled = false;
            function fin(ok, kind) {
                if (settled) return; settled = true;
                clearTimeout(watchdog);
                settle(item, ok, kind);
            }
            var watchdog = setTimeout(function () { fin(false, 'timeout'); }, DL_TIMEOUT * 2);
            extract(item).then(function (res) {
                saveBlob(res.blob, res.name, prefix, function (how) {
                    if (how === 'fallback') fallbacks.push(res.name);
                    fin(how !== 'erro', how === 'erro' ? 'fatal' : undefined);
                });
            }, function (err) {
                fin(false, typeof err === 'string' ? err : 'fatal');
            });
        }

        function launch(item) {
            if (item.kind === 'extract') return launchExtract(item);
            inFlight++;
            var prazo = DL_TIMEOUT + Math.min(600000, inFlight * 2000);
            var settled = false, handle;
            function fin(ok, kind) {
                if (settled) return; settled = true;
                clearTimeout(watchdog);
                if (!ok && CONFIG_ERRORS[kind]) {
                    if (!finished) { finished = true; reply({ type: 'config' }); }
                    return;
                }
                settle(item, ok, kind);
            }
            var watchdog = setTimeout(function () {
                try { if (handle && handle.abort) handle.abort(); } catch (e) {}
                fin(false, 'timeout');
            }, prazo + 5000);
            try {
                handle = GM_download({
                    url: item.url,
                    name: prefix + item.name,
                    saveAs: false,
                    timeout: prazo,
                    onload: function () { fin(true); },
                    ontimeout: function () { fin(false, 'timeout'); },
                    onerror: function (err) { fin(false, (err && err.error) || 'network'); }
                });
            } catch (e) {
                fin(false, 'fatal');
            }
        }
        function pump() {
            if (finished) return;
            if (done >= total && inFlight === 0 && pending.length === 0) {
                finished = true;
                reply({ type: 'done', total: total, failures: failures, fallbacks: fallbacks });
                return;
            }
            while (inFlight < concurrency && pending.length) {
                var wait = launchGap - (Date.now() - lastLaunch);
                if (wait > 0) { setTimeout(pump, wait); return; }
                lastLaunch = Date.now();
                launch(pending.shift());
            }
        }
        var heartbeat = setInterval(function () {
            if (finished) { clearInterval(heartbeat); return; }
            reply({ type: 'ping' });
        }, 10000);
        reportarProgresso();
        pump();
    }

    function onHostMessage(ev) {
        if (ev.origin !== location.origin) return;
        var d = ev.data;
        if (!d || d.__tceReq !== 1 || !d.batchId || !Array.isArray(d.items) || !d.items.length) return;
        if (typeof GM_download !== 'function' || typeof GM_xmlhttpRequest !== 'function') {
            try { ev.source.postMessage({ __tce: 1, batchId: d.batchId, type: 'config' }, '*'); } catch (e) {}
            return;
        }
        var folder = (typeof d.folder === 'string' && /^\d[\d.\-]{0,59}$/.test(d.folder)) ? d.folder : '';
        var items = [];
        for (var i = 0; i < d.items.length; i++) {
            var it = d.items[i];
            if (!it || typeof it.url !== 'string' || typeof it.name !== 'string') continue;
            if (it.url.indexOf(location.origin + '/') !== 0) continue;
            // o nome vem da página: barra/ponto-ponto nunca entram no caminho
            var name = it.name.replace(/[\\/]+/g, '-').replace(/^\.+/, '') || 'arquivo';
            items.push({ url: it.url, name: name, kind: it.kind === 'direct' ? 'direct' : 'extract' });
        }
        if (items.length) runDownloadBatch(items, ev.source, d.batchId, folder);
    }

    W.addEventListener('message', onHostMessage);
    scan();
    setInterval(scan, 3000);
})();

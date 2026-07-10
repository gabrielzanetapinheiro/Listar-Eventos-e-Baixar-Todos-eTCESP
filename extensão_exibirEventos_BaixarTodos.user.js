// ==UserScript==
// @name         E-TCESP - Evento + Baixar Todos
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Exibe (ev. X.Y) antes do nome do arquivo e adiciona botão para baixar todos (sem travar a página)
// @match        https://e-processo.tce.sp.gov.br/*
// @noframes     true
// @grant        GM_download
// @connect      e-processo.tce.sp.gov.br
// @connect      self
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
            try { console.log('[E-TCESP v1.9] ' + msg); } catch (e) {}
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
                // FIX 1: força display:inline !important para não herdar o display:none
                // que o CSS do site aplica a <span> nesse layout de processo.
                span.style.cssText = 'font-weight:bold;color:#1a5276;font-size:12px;';
                span.style.setProperty('display', 'inline', 'important');
                fileLink.insertAdjacentElement('beforebegin', span);
                added++;
            }
            return added;
        }

        // FIX 1b: rede de segurança — reforça o display em máscaras já existentes
        // caso o site tenha reescrito o estilo depois de um re-render.
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

        function collectFiles() {
            var out = [];
            document.querySelectorAll('a[href*="DownloadArquivo"]').forEach(function (a) {
                var name = a.textContent.trim();
                var lower = name.toLowerCase();
                if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.lnk')) return;
                var ev = getEvNum(a);
                out.push({ url: a.href, name: sanitizeFileName(ev ? '(ev. ' + ev + ') ' + name : name) });
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
                // FIX 3: ao terminar o lote, reaplica imediatamente as máscaras
                // (elas podem ter sumido se o frame re-renderizou durante o download).
                run();
            }
            function onMsg(ev) {
                var d = ev.data;
                if (!d || d.__tce !== 1 || d.batchId !== batchId) return;
                clearTimeout(noReply);
                noReply = setTimeout(onNoReply, 30000);
                if (d.type === 'progress') {
                    btn.textContent = 'Baixando ' + d.done + '/' + d.total +
                                      (d.failures ? ' (' + d.failures + ' falha)' : '') + '...';
                    btn.style.background = '#78350f';
                } else if (d.type === 'config') {
                    cleanup();
                    retryItems = items;
                    alert('O Tampermonkey precisa de permissão para baixar arquivos.\n\n' +
                          'Abra o painel da extensão Tampermonkey → Configurações →\n' +
                          'Downloads e habilite o modo de download do navegador.\n\n' +
                          'Depois clique novamente no botão para repetir.');
                    btn.textContent = 'Habilite downloads no Tampermonkey e repita';
                    btn.style.background = '#92400e';
                    resetButtonLater(btn, 8000);
                } else if (d.type === 'done') {
                    cleanup();
                    var fails = d.failures || [];
                    retryItems = fails.length ? fails : null;
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
            (window.top || window).postMessage({ __tceReq: 1, batchId: batchId, items: items }, '*');
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

            // FIX 2: guarda o estado REAL de cada dropdown (inclusive os que o
            // usuário abriu manualmente) para restaurar exatamente como estava.
            var expanded = [];
            document.querySelectorAll('span[id^="subMostra"]').forEach(function (s) {
                expanded.push({ el: s, prev: s.style.display }); // salva TODOS, aberto ou fechado
                s.style.display = 'block';
            });
            function restore() {
                for (var i = 0; i < expanded.length; i++) {
                    try { expanded[i].el.style.display = expanded[i].prev; } catch (e) {}
                }
                // FIX 2b/3: logo após recolher, reaplica as máscaras para os
                // eventos nunca ficarem "sem número" durante/depois da coleta.
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
                var msg = 'Baixar ' + items.length + ' arquivo(s)?\n' +
                          '(Arquivos .html e .lnk são ignorados)\n\n' +
                          'O Tampermonkey salva direto na sua pasta de Downloads —\n' +
                          'não é preciso mexer nas configurações do Chrome.';
                if (!confirm(msg)) {
                    downloading = false; resumeBackground();
                    run(); // reaplica máscaras após o cancelamento
                    return;
                }
                btn.dataset.busy = '1';
                startBatch(items, btn);
            }, 600);
        }

        // ── EXECUÇÃO IDEMPOTENTE ──
        function run() {
            try {
                // FIX 3: mesmo durante o download, mantém as máscaras aplicadas e
                // visíveis (só evita mexer nos dropdowns). Antes o "return" deixava
                // os eventos sem número por todo o lote.
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

    // ── HOST DE DOWNLOAD ──
    var DL_TIMEOUT = 120000;
    var CONFIG_ERRORS = { not_enabled: 1, not_whitelisted: 1, not_permitted: 1, not_supported: 1 };
    var TRANSIENT = { timeout: 1, network: 1, server_error: 1 };

    function runDownloadBatch(items, source, batchId) {
        var pending = items.map(function (it) { return { url: it.url, name: it.name, tries: 0 }; });
        var total = pending.length;
        var done = 0, inFlight = 0;
        var failures = [];
        var concurrency = 2, okStreak = 0, failStreak = 0;
        var launchGap = 200, lastLaunch = 0;
        var finished = false;

        function reply(msg) {
            msg.__tce = 1; msg.batchId = batchId;
            try { source.postMessage(msg, '*'); } catch (e) {}
        }
        function slowDown() {
            failStreak++;
            if (failStreak >= 2) { concurrency = 1; launchGap = Math.min(3000, launchGap * 2); failStreak = 0; }
        }
        function settle(item, ok, kind) {
            inFlight--;
            if (ok) {
                done++; okStreak++; failStreak = 0;
                if (okStreak >= 5 && concurrency < 3) { concurrency++; okStreak = 0; launchGap = Math.max(150, launchGap - 50); }
            } else if (TRANSIENT[kind] && item.tries < 3) {
                item.tries++; okStreak = 0; slowDown();
                setTimeout(function () { pending.push(item); pump(); }, item.tries === 1 ? 2000 : 8000);
            } else {
                done++; okStreak = 0; slowDown();
                failures.push({ url: item.url, name: item.name });
            }
            reply({ type: 'progress', done: done, total: total, failures: failures.length });
            pump();
        }
        function launch(item) {
            inFlight++;
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
            }, DL_TIMEOUT + 5000);
            try {
                handle = GM_download({
                    url: item.url,
                    name: item.name,
                    saveAs: false,
                    timeout: DL_TIMEOUT,
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
                reply({ type: 'done', total: total, failures: failures });
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
        reply({ type: 'progress', done: 0, total: total, failures: 0 });
        pump();
    }

    function onHostMessage(ev) {
        if (ev.origin !== location.origin) return;
        var d = ev.data;
        if (!d || d.__tceReq !== 1 || !d.batchId || !Array.isArray(d.items) || !d.items.length) return;
        if (typeof GM_download !== 'function') {
            try { ev.source.postMessage({ __tce: 1, batchId: d.batchId, type: 'config' }, '*'); } catch (e) {}
            return;
        }
        var items = [];
        for (var i = 0; i < d.items.length; i++) {
            var it = d.items[i];
            if (!it || typeof it.url !== 'string' || typeof it.name !== 'string') continue;
            if (it.url.indexOf(location.origin + '/') !== 0) continue;
            items.push({ url: it.url, name: it.name });
        }
        if (items.length) runDownloadBatch(items, ev.source, d.batchId);
    }

    W.addEventListener('message', onHostMessage);
    scan();
    setInterval(scan, 3000);
})();

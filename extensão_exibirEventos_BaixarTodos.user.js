// ==UserScript==
// @name         E-TCESP - Exibir Eventos + Botão Baixar Todos
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Exibe (ev. X.Y) antes do nome do arquivo e adiciona botão para baixar todos os arquivos do TC numa pasta com o número do processo (1ª parte com 6 dígitos, ex.: 004421.989.24-5).
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

    // ─────────────────────────────────────────────────────────────────────
    // PONTE DE DOWNLOAD (roda no SANDBOX do Tampermonkey, só no frame de topo)
    // GM_download só existe aqui — o código injetado na página (qualquer frame)
    // manda a lista via postMessage e este bridge faz o download em subpasta.
    // ─────────────────────────────────────────────────────────────────────
    if (window.top === window) {
        window.addEventListener('message', function (ev) {
            var d = ev.data;
            if (!d || d.__tceDL !== 1 || d.kind !== 'start') return;
            var src = ev.source;
            var folder = d.folder || '';
            var files = d.files || [];

            function reply(msg) {
                try {
                    msg.__tceDL = 1;
                    if (src) src.postMessage(msg, '*');
                } catch (e) {}
            }

            if (typeof GM_download !== 'function') { reply({ kind: 'error', code: 'no-gm' }); return; }

            // Baixa vários arquivos ao mesmo tempo (pool de concorrência) em vez
            // de um por um. CONCURRENCY = quantos downloads simultâneos.
            var CONCURRENCY = Math.min(6, files.length) || 1;
            var i = 0, done = 0, failures = 0;
            reply({ kind: 'progress', done: 0, total: files.length, failures: 0 });

            function startOne() {
                if (i >= files.length) return;
                var f = files[i++];
                var name = (folder ? folder + '/' : '') + f.name;
                var settled = false;
                function settle(ok) {
                    if (settled) return;
                    settled = true;
                    if (!ok) failures++;
                    done++;
                    reply({ kind: 'progress', done: done, total: files.length, failures: failures });
                    if (done >= files.length) { reply({ kind: 'done', failures: failures, total: files.length }); return; }
                    startOne();   // assim que um termina, dispara o próximo da fila
                }
                try {
                    GM_download({
                        url: f.url,
                        name: name,
                        saveAs: false,
                        onload:    function () { settle(true); },
                        onerror:   function () { settle(false); },
                        ontimeout: function () { settle(false); }
                    });
                } catch (e) { settle(false); }
            }

            // dispara o primeiro lote; cada término puxa o próximo
            for (var k = 0; k < CONCURRENCY; k++) startOne();
        }, false);
    }

    // ─────────────────────────────────────────────────────────────────────
    // CÓDIGO INJETADO NO CONTEXTO DA PÁGINA (todos os frames): máscara + botão
    // ─────────────────────────────────────────────────────────────────────
    var scriptCode = '(' + function () {
        'use strict';

        // Evita inicialização dupla na mesma janela (sobrevive à troca de body)
        if (window.__tceComboInit) return;
        window.__tceComboInit = true;

        var EVENT_RE = /^\d+\.\d+$/;
        var observer = null;
        var heartbeat = null;
        var lastState = '';
        var downloading = false;   // trava o trabalho de fundo durante o "Baixar Todos"

        function pauseBackground() {
            try { if (observer) observer.disconnect(); } catch (e) {}
            try { if (heartbeat) clearInterval(heartbeat); } catch (e) {}
            heartbeat = null;
        }
        function resumeBackground() {
            try { if (observer) observer.observe(document, { childList: true, subtree: true }); } catch (e) {}
            if (!heartbeat) heartbeat = setInterval(run, 1500);
        }

        function log(msg) {
            try { console.log('[E-TCESP v1.4] ' + msg); } catch (e) {}
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
                fileLink.insertAdjacentElement('beforebegin', span);
                added++;
            }
            return added;
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
            return (name || 'arquivo')
                .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 180) || 'arquivo';
        }

        // ── NÚMERO DO PROCESSO ──────────────────────────────────────────────
        // Fonte confiável: <td class="numProcesso"><a href="...numeroProcesso=4421989245">00004421.989.24-5</a>
        // Preferimos o canônico do href (só dígitos) e reconstruímos a máscara;
        // se não houver, caímos no texto formatado. Buscamos no documento local
        // e, como reserva, em todos os frames de mesma origem.
        function collectFrames(win, out) {
            try { out.push(win); } catch (e) { return; }
            var n = 0;
            try { n = win.frames.length; } catch (e) { return; }   // cross-origin
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

        // 1ª parte com 6 dígitos (tira zeros à esquerda, mantém no mínimo 6).
        function first6(seg) {
            var v = String(parseInt(seg, 10));
            if (v === 'NaN') v = '0';
            return v.length >= 6 ? v : ('000000' + v).slice(-6);
        }

        // Canônico "4421989245" = <parte1><NNN><NN><D> (últimos 6 dígitos = 989.24-5)
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
            if (!f) return null;
            // caracteres seguros p/ nome de pasta (só deve conter dígitos . e -)
            return f.replace(/[\\/:*?"<>|\r\n\t]+/g, '-').trim();
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

        function resetBtn(btn) {
            btn.textContent = 'Baixar Todos os Arquivos';
            btn.style.background = '#1a5276';
        }

        function onDownloadClick(btn, e) {
            e.preventDefault();
            if (downloading || btn.dataset.busy === '1') return;

            downloading = true;
            pauseBackground();

            // Expande os dropdowns p/ garantir que os arquivos estejam no DOM.
            var expanded = [];
            document.querySelectorAll('span[id^="subMostra"]').forEach(function (s) {
                if (s.style.display !== 'block') { expanded.push(s); s.style.display = 'block'; }
            });
            function restore() {
                for (var i = 0; i < expanded.length; i++) {
                    try { expanded[i].style.display = 'none'; } catch (e) {}
                }
            }
            function release() {
                restore();
                downloading = false;
                btn.dataset.busy = '';
                resumeBackground();
            }

            setTimeout(function () {
                var allLinks = document.querySelectorAll('a[href*="DownloadArquivo"]');
                var toDownload = [];
                allLinks.forEach(function (a) {
                    var name = a.textContent.trim();
                    var lower = name.toLowerCase();
                    if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.lnk')) return;
                    var ev = getEvNum(a);
                    toDownload.push({ url: a.href, name: sanitizeFileName(ev ? '(ev. ' + ev + ') ' + name : name) });
                });

                restore(); // URLs já capturadas — não precisamos mais dos dropdowns abertos

                if (!toDownload.length) { alert('Nenhum arquivo encontrado.'); release(); return; }

                var folder = getProcessFolder();

                var msg = 'Baixar ' + toDownload.length + ' arquivo(s)?\n' +
                          '(Arquivos .html e .lnk serão ignorados)\n\n' +
                          (folder
                              ? ('Pasta de destino (dentro de Downloads):\n    ' + folder + '\n')
                              : ('⚠ Não consegui detectar o número do processo — os arquivos irão\n' +
                                 'direto para a raiz da pasta Downloads.\n')) +
                          '\nDica: em chrome://settings/downloads DESATIVE\n' +
                          '"Perguntar onde salvar cada arquivo antes de baixar".';
                if (!confirm(msg)) { release(); return; }

                btn.dataset.busy = '1';
                btn.textContent = 'Enviando...';
                btn.style.background = '#78350f';

                var guard = null;
                function armGuard(ms) {
                    if (guard) clearTimeout(guard);
                    guard = setTimeout(function () { finishUI(0, toDownload.length, 'timeout'); }, ms);
                }
                function finishUI(failures, total, how) {
                    if (guard) { clearTimeout(guard); guard = null; }
                    window.removeEventListener('message', onMsg);
                    release();
                    if (how === 'timeout') {
                        btn.textContent = 'Sem resposta — confira GM_download';
                        btn.style.background = '#92400e';
                    } else if (how === 'no-gm') {
                        btn.textContent = 'Habilite GM_download';
                        btn.style.background = '#92400e';
                        alert('GM_download não está disponível.\n\n' +
                              'No cabeçalho da extensão deve constar "@grant GM_download".\n' +
                              'Além disso, no Tampermonkey (Configurações → Downloads) habilite\n' +
                              'o modo de download do navegador e as subpastas, e libere as\n' +
                              'extensões de arquivo (ou use *). Depois recarregue a página.');
                    } else {
                        btn.textContent = failures ? ('Concluído — ' + failures + ' falha(s)') : 'Concluído!';
                        btn.style.background = failures ? '#92400e' : '#065f46';
                    }
                    setTimeout(function () { resetBtn(btn); }, 5000);
                }

                function onMsg(ev2) {
                    var d = ev2.data;
                    if (!d || d.__tceDL !== 1) return;
                    if (d.kind === 'progress') {
                        armGuard(60000);
                        if (d.done < d.total) {
                            btn.textContent = 'Baixando ' + d.done + '/' + d.total + '...';
                            btn.style.background = '#78350f';
                        }
                    } else if (d.kind === 'done') {
                        finishUI(d.failures || 0, d.total || toDownload.length, 'ok');
                    } else if (d.kind === 'error') {
                        finishUI(0, toDownload.length, d.code === 'no-gm' ? 'no-gm' : 'timeout');
                    }
                }

                window.addEventListener('message', onMsg, false);
                armGuard(15000); // se o bridge nem responder o 1º progress

                try {
                    (window.top || window).postMessage(
                        { __tceDL: 1, kind: 'start', folder: folder, files: toDownload }, '*');
                } catch (err) {
                    window.removeEventListener('message', onMsg);
                    release();
                    alert('Falha ao acionar o download: ' + (err && err.message));
                    resetBtn(btn);
                    btn.dataset.busy = '';
                }
            }, 400);
        }

        // ── EXECUÇÃO IDEMPOTENTE ──
        function run() {
            if (downloading) return;
            try {
                var addedMasks = showEventNumbers();
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

        heartbeat = setInterval(run, 1500);

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
        try { n = win.frames.length; } catch (e) { return; } // cross-origin
        for (var i = 0; i < n; i++) {
            try { scanWin(win.frames[i], depth + 1); } catch (e) {}
        }
    }

    function scan() { scanWin(window, 0); }

    scan();
    setInterval(scan, 3000);
})();

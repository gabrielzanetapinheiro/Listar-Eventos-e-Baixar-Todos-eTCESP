// ==UserScript==
// @name         E-TCESP - Evento + Baixar Todos
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Exibe (ev. X.Y) antes do nome do arquivo e adiciona botão para baixar todos (sem travar a página)
// @match        https://e-processo.tce.sp.gov.br/*
// @noframes     true
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/gabrielzanetapinheiro/Listar-Eventos-e-Baixar-Todos-eTCESP/main/extens%C3%A3o_exibirEventos_BaixarTodos.user.js
// @updateURL    https://raw.githubusercontent.com/gabrielzanetapinheiro/Listar-Eventos-e-Baixar-Todos-eTCESP/main/extens%C3%A3o_exibirEventos_BaixarTodos.user.js
// ==/UserScript==

(function () {
    'use strict';

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

        // Pausa/retoma observer + heartbeat para não disparar varreduras
        // pesadas (TreeWalker no documento inteiro) durante o download em lote.
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
            try { console.log('[E-TCESP v1.0] ' + msg); } catch (e) {}
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
                if (!fileLink) continue;                                       // link ainda não renderizou
                if (fileLink.parentElement.querySelector('.evt-num')) continue; // já inserido
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
            if (!navLink) return false;                 // página ainda não é a de eventos
            var existing = document.getElementById('tce-dl-btn');
            if (existing) {
                if (existing.isConnected) return false; // já presente e válido
                existing.remove();                      // resíduo órfão após re-render
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

        function onDownloadClick(btn, e) {
            e.preventDefault();
            if (downloading || btn.dataset.busy === '1') return;   // trava contra clique repetido

            // Pausa o trabalho de fundo ANTES de mexer no DOM. Sem isso, expandir
            // os dropdowns e inserir/remover um <a> por arquivo dispara o observer
            // + heartbeat em laço, varrendo o documento inteiro a cada mutação —
            // é a causa do travamento e da RAM nas alturas.
            downloading = true;
            pauseBackground();

            // Expande os dropdowns p/ garantir que os arquivos estejam no DOM,
            // guardando quais nós alteramos para restaurar depois.
            var expanded = [];
            document.querySelectorAll('span[id^="subMostra"]').forEach(function (s) {
                if (s.style.display !== 'block') { expanded.push(s); s.style.display = 'block'; }
            });
            function restore() {
                for (var i = 0; i < expanded.length; i++) {
                    try { expanded[i].style.display = 'none'; } catch (e) {}
                }
            }
            function release(resume) {
                restore();
                downloading = false;
                btn.dataset.busy = '';
                if (resume !== false) resumeBackground();
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

                if (!toDownload.length) { alert('Nenhum arquivo encontrado.'); release(); return; }

                var msg = 'Baixar ' + toDownload.length + ' arquivo(s)?\n' +
                          '(Arquivos .html e .lnk serão ignorados)\n\n' +
                          '⚠ Para o download em lote funcionar, em chrome://settings/downloads\n' +
                          'DESATIVE a opção "Perguntar onde salvar cada arquivo antes de baixar".\n' +
                          'Com ela ligada, os arquivos falham ou abrem uma janela por arquivo.\n\n' +
                          'Obs.: o aviso "Baixar vários arquivos?" do próprio Chrome é normal — clique em PERMITIR.';
                if (!confirm(msg)) { release(); return; }

                btn.dataset.busy = '1';
                var idx = 0, failures = 0, aborted = false;

                function finish() {
                    release();
                    btn.textContent = failures ? ('Concluído — ' + failures + ' falha(s)') : 'Concluído!';
                    btn.style.background = failures ? '#92400e' : '#065f46';
                    setTimeout(function () { btn.textContent = 'Baixar Todos os Arquivos'; btn.style.background = '#1a5276'; }, 4000);
                }

                // ── Detecção da opção "Perguntar onde salvar cada arquivo" ──
                // A janela nativa "Salvar como" tira o foco IMEDIATAMENTE após o
                // nosso clique programático (reação da máquina, poucos ms). Já um
                // usuário com várias telas que clica em outra janela/monitor tira
                // o foco num instante ALEATÓRIO, sem correlação com o clique (e a
                // aba continua "visible", então só checar visibilidade não basta).
                // Por isso exigimos que o blur ocorra logo após o clique (< 400ms):
                // assim não confundimos troca de tela com a janela de salvar.
                // Sondamos só no 1º arquivo, antes de o aviso de múltiplos
                // downloads do Chrome aparecer (ele só surge no 2º e não tira foco).
                var clickTime = 0, blurDelay = -1;
                function onBlur() { if (clickTime) blurDelay = performance.now() - clickTime; }

                function probeSaveDialog() {
                    window.removeEventListener('blur', onBlur);
                    if (blurDelay >= 0 && blurDelay < 400 && document.visibilityState === 'visible' && !document.hidden) {
                        aborted = true;
                        release();
                        alert('Parece que a opção "Perguntar onde salvar cada arquivo antes de baixar" está ATIVADA no Chrome.\n\n' +
                              'Com ela ligada, o download em lote não funciona (abre uma janela "Salvar como" por arquivo).\n\n' +
                              'Como resolver:\n' +
                              '1) Abra chrome://settings/downloads\n' +
                              '2) DESLIGUE "Perguntar onde salvar cada arquivo antes de baixar"\n' +
                              '3) Clique novamente em "Baixar Todos os Arquivos"\n\n' +
                              '(Isto NÃO é o aviso "Baixar vários arquivos?" do Chrome — esse você DEVE permitir.)');
                        btn.textContent = 'Desative "perguntar onde salvar" e repita';
                        btn.style.background = '#92400e';
                        setTimeout(function () { btn.textContent = 'Baixar Todos os Arquivos'; btn.style.background = '#1a5276'; }, 6000);
                    }
                }

                function downloadOne(item, cb) {
                    fetch(item.url, { credentials: 'include' })
                        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
                        .then(function (blob) {
                            var u = URL.createObjectURL(blob);
                            var a = document.createElement('a');
                            a.href = u; a.download = item.name; a.style.display = 'none';
                            document.body.appendChild(a);
                            clickTime = performance.now(); a.click();
                            // Mantém a objectURL viva tempo suficiente para o navegador
                            // iniciar a gravação (200ms revogava cedo demais e quebrava
                            // o download quando o "Salvar como" estava ligado).
                            setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(u); }, 1500);
                            cb(true);
                        })
                        .catch(function () { cb(false); });
                }

                function next() {
                    if (aborted) return;
                    if (idx >= toDownload.length) { finish(); return; }
                    var item = toDownload[idx];
                    var first = (idx === 0);
                    btn.textContent = 'Baixando ' + (idx + 1) + '/' + toDownload.length + '...';
                    btn.style.background = '#78350f';
                    if (first) { blurDelay = -1; clickTime = 0; window.addEventListener('blur', onBlur); }
                    downloadOne(item, function (ok) {
                        if (!ok) failures++;
                        if (first) {
                            // Dá tempo de a janela "Salvar como" (se existir) roubar o foco.
                            setTimeout(function () {
                                probeSaveDialog();
                                if (aborted) return;
                                idx++; setTimeout(next, 700);
                            }, 600);
                        } else {
                            idx++; setTimeout(next, 700);
                        }
                    });
                }
                next();
            }, 600);
        }

        // ── EXECUÇÃO IDEMPOTENTE ──
        function run() {
            if (downloading) return;   // não varre o DOM durante o download em lote
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
            setTimeout(function () { scheduled = false; run(); }, 150); // debounce do observer
        }

        log('iniciado (' + (window.self === window.top ? 'topo' : 'frame') + ') ' + location.pathname);
        run();

        // 1) reage na hora a mudanças do DOM (carregamento tardio, abrir dropdown, re-render)
        observer = new MutationObserver(schedule);
        try { observer.observe(document, { childList: true, subtree: true }); } catch (e) {}

        // 2) reexecuções rápidas para o timing inicial (requirejs/AJAX)
        [300, 900, 2000].forEach(function (t) { setTimeout(run, t); });

        // 3) heartbeat resiliente: um único timer por janela (idempotente).
        //    Sobrevive a reescrita do documento / morte do observer — reaplica a máscara se for apagada.
        heartbeat = setInterval(run, 1500);

        // limpeza
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
            win.__tceCombo = true;                       // marca antes de injetar (evita corrida)
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
    setInterval(scan, 3000); // descobre frames criados dinamicamente / navegações de frame
})();

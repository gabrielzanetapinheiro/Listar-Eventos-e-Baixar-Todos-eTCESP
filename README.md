# Listar Eventos e Baixar Todos — e-TCESP

Userscript (Tampermonkey) para o **e-Processo do TCESP** (`https://e-processo.tce.sp.gov.br`).
Resolve duas dores do dia a dia da fiscalização: descobrir a qual evento pertence cada arquivo e
baixar o processo inteiro sem clicar arquivo por arquivo.

**Autor:** Gabriel Zaneta Pinheiro — Estagiário UR-02
**Versão atual:** 1.6

---

## O que a ferramenta faz

### 1. Mostra o número do evento ao lado de cada arquivo

Na listagem do processo, o número do evento aparece em destaque antes do nome do arquivo:

```
(ev. 12.3) | Ofício de encaminhamento.pdf
```

Assim não é preciso entrar em **"Navegar Pelo Processo"** só para descobrir de onde veio o documento.

A marcação é reaplicada sozinha quando a página se atualiza (o e-Processo re-renderiza a lista com
frequência), inclusive dentro dos frames internos do sistema.

### 2. Botão "Baixar Todos os Arquivos"

Um botão azul é inserido ao lado do link **"Navegar Pelo Processo"**. Ao clicar:

- todos os grupos de eventos são expandidos temporariamente para localizar os arquivos e depois
  voltam exatamente ao estado em que estavam;
- é exibida uma confirmação com a quantidade de arquivos encontrados;
- cada arquivo é salvo já nomeado como `(ev. X.Y) Nome do arquivo.pdf`;
- o lote inteiro vai para uma pasta com o número do processo dentro de **Downloads**
  (ex.: `Downloads/004421.989.24-5/`) — exige o **Passo 5**;
- arquivos `.html`, `.htm` e `.lnk` (atalhos e páginas de apoio do sistema) são ignorados;
- o botão mostra o progresso em tempo real: `Baixando 37/120...`.

### 3. Controle de ritmo automático

O lote começa disparando todos os downloads de uma vez. Se o servidor do TCESP der sinal de
saturação (timeout, erro de rede, 5xx), o script **reduz sozinho** o número de downloads simultâneos
e passa a espaçar os disparos — apertando mais a cada nova falha. O botão indica isso com
`[ritmo reduzido]`.

### 4. Nova tentativa dos que falharam

Se algum arquivo não vier, o botão muda para `N falha(s) — clique p/ repetir`. Um novo clique
tenta **apenas os que falharam**, sem rebaixar tudo de novo.

---

## Instalação

### Passo 1 — Instalar a extensão Tampermonkey

O userscript não roda sozinho: ele precisa do Tampermonkey, que é a extensão que executa scripts
dentro das páginas.

| Navegador | Link |
|---|---|
| Chrome / Edge | [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Add-ons do Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/) |

Clique em **Adicionar ao Chrome** (ou equivalente) e confirme.

### Passo 2 — Liberar "Permitir scripts de usuário" (Chrome e Edge)

> ⚠️ **Passo obrigatório no Chrome 138+ e no Edge recentes.** Sem ele o Tampermonkey instala o
> script, mostra que está ativo, **mas nada aparece na página** — nem o número do evento, nem o botão.

1. Abra `chrome://extensions` (no Edge, `edge://extensions`).
2. Localize o **Tampermonkey** e clique em **Detalhes**.
3. Ative a chave **"Permitir scripts de usuário"** (*Allow User Scripts*).
4. Se essa opção não aparecer, ative primeiro o **Modo do desenvolvedor** no canto superior direito
   da página de extensões, e volte ao passo 2.

O Tampermonkey costuma exibir um aviso vermelho no próprio ícone enquanto isso não é feito.

### Passo 3 — Instalar o script

Com o Tampermonkey já instalado, abra o link abaixo — ele abre direto a tela de instalação do
Tampermonkey, onde basta clicar em **Instalar**:

👉 [**Instalar o script**](https://raw.githubusercontent.com/gabrielzanetapinheiro/Listar-Eventos-e-Baixar-Todos-eTCESP/main/extens%C3%A3o_exibirEventos_BaixarTodos.user.js)

**Instalação manual (alternativa):**

1. Clique no ícone do Tampermonkey → **Painel de controle**.
2. Aba **"+"** (Criar novo script).
3. Apague todo o conteúdo de exemplo.
4. Cole o conteúdo do arquivo `extensão_exibirEventos_BaixarTodos.user.js` deste repositório.
5. **Ctrl + S** para salvar.

Depois, abra ou recarregue uma página de processo no e-Processo.

### Passo 4 — Liberar downloads múltiplos no navegador

Na **primeira vez** que você clicar em **"Baixar Todos os Arquivos"**, o navegador vai perguntar se
o site pode baixar vários arquivos de uma vez — uma barra no topo da janela com algo como
**"e-processo.tce.sp.gov.br quer fazer download de vários arquivos"**.

**Clique em "Permitir".** Se você clicar em "Bloquear" (ou ignorar), só o primeiro arquivo é salvo
e o restante do lote é descartado silenciosamente.

Se o aviso já tiver sido bloqueado antes, é possível corrigir:

1. Clique no ícone de cadeado (ou de configurações) na barra de endereço, ao lado da URL.
2. Vá em **Configurações do site**.
3. Em **Downloads automáticos**, selecione **Permitir**.
4. Recarregue a página.

O caminho equivalente pelas configurações do Chrome é
`chrome://settings/content/automaticDownloads`.

### Passo 5 — Habilitar as subpastas no Tampermonkey

Para que o lote seja salvo na pasta com o número do processo, o Tampermonkey precisa ter permissão
de gravar em subpastas de **Downloads**:

1. Clique no ícone do Tampermonkey → **Painel de controle**.
2. Aba **Configurações** (mude o "Modo de configuração" para **Avançado**, se necessário).
3. Na seção **Downloads**, habilite o **modo de download do navegador**.
4. Ainda ali, permita as **subpastas** (*Subdirectory* / *Subdiretório*).

Sem isso, o Tampermonkey recusa o lote e o botão mostra
`Habilite downloads no Tampermonkey e repita`.

---

## Solução de problemas

| Sintoma | O que fazer |
|---|---|
| Nada aparece na página (sem número de evento e sem botão) | Confirme o **Passo 2** — "Permitir scripts de usuário" ativado no Tampermonkey. |
| Só o primeiro arquivo é baixado | Downloads múltiplos bloqueados — veja o **Passo 4**. |
| Botão diz *"Habilite downloads no Tampermonkey e repita"* | Painel do Tampermonkey → **Configurações** → **Downloads** → habilite o modo de download do navegador **e as subpastas** (veja o **Passo 5**). Depois clique no botão de novo. |
| Os arquivos caíram soltos na raiz de Downloads | O número do processo não foi encontrado na tela. Confirme que está na página do processo (com o número visível no topo) e não em outra aba do sistema. |
| Botão diz *"Sem resposta — recarregue e repita"* | Recarregue a página do processo e tente novamente. |
| Alguns arquivos falharam | Clique no botão outra vez: ele repete **apenas** os que falharam. |
| *"Nenhum arquivo encontrado"* | Verifique se você está na tela de listagem de arquivos do processo, e não em outra aba do sistema. |

Os arquivos vão para uma pasta com o número do processo dentro da pasta padrão de **Downloads** do
navegador. Quando o número do processo não é encontrado na tela, o lote cai na raiz de Downloads —
a confirmação exibida antes do download sempre informa qual será o destino.

---

## Atualizações

O script declara `@updateURL` apontando para este repositório, então o Tampermonkey verifica
atualizações automaticamente. Para forçar: painel do Tampermonkey → aba **Utilitários** →
**Verificar atualizações de userscripts**.

# Bot de pedidos do WhatsApp (n8n) ↔ Supabase

Workflow: **TEST Geral - Mensagens Perfeitas (Pedra/Tijolo R$1)** (`OTLMcldxL4SZNDaj`, n8n da OCI, instância Evolution `Geral`).

## O que mudou
- O node `Router` deixou de usar o catálogo fixo (Pedra/Tijolo) e lê a view pública **`catalogo_ativo`** do
  Supabase (`supabase/migrations/003_catalogo_ativo.sql`) com a chave publishable. Só itens **ativos** no painel
  aparecem; ligar/desligar sabor ou tamanho no painel reflete no bot na hora.
- Cada tamanho é um item do menu ("Acerola (1 kg), R$ 16,00"), numerado e agrupado por sabor. O cliente escolhe
  pelo número ou digitando o nome (se for único). O preço vem do banco no momento da escolha.
- Se o Supabase não responder, o bot chama o atendente humano (não cai em catálogo fixo). Catálogo vazio = silêncio, como antes.

## Tabelas `n8n_*` (migração 004)
Espelho do banco `clientes_controle_mensagens` da VM: `n8n_clientes`, `n8n_chat_state`, `n8n_cliente_nome`,
`n8n_endereco_cliente`, `n8n_contato_ultimo_visto`, `n8n_flags_bot`, `n8n_pedidos`, `n8n_cobrancas`.
RLS ligada e sem acesso para `anon`/`authenticated`: só conexão Postgres do n8n / `service_role`.
`n8n_clientes` já tem o cliente id 4 (o que este fluxo usa).

**Ainda não migrado:** os nodes Postgres do fluxo continuam gravando no Postgres da VM. Trocar para as tabelas `n8n_*`
exige (1) uma credencial Postgres no n8n apontando para o Supabase (pooler, a VM é IPv4) e (2) migrar junto os
workflows `MP Pagamentos - Processar` e `Expirar Cobrancas Pendentes`, que leem/atualizam `cobrancas` no banco da VM,
senão a confirmação de pagamento não encontra a cobrança.

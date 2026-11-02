# Supabase (banco do painel)

Projeto de referência: `qhqutekauzveehmfofxj` (NaturalSabor). Migrações em `migrations/`, para rodar **em ordem**:

| Arquivo | O que faz |
|---|---|
| `001_schema.sql` | tabelas, restrições, triggers de transição de status e de frete congelado, RLS, `rotina_prazos()`, seed (config, feriados, catálogo de exemplo) |
| `002_cron_10s.sql` | liga o `pg_cron` e agenda a rotina de prazos a cada 10 s |
| `003_catalogo_ativo.sql` | view pública `catalogo_ativo` (só itens ativos) para o bot do n8n ler com a chave publishable |
| `004_n8n_tabelas.sql` | tabelas `n8n_*` (espelho do banco do bot na VM), com RLS e sem acesso anônimo |
| `005_trocar_itens_pedido.sql` | função `trocar_itens_pedido()`: troca os itens de um pedido numa única transação |

## O que roda onde

| Peça | Onde roda hoje | Destino em produção |
|---|---|---|
| Login do operador | Supabase Auth (`operadores` = perfil/permissão) | igual |
| Pedidos, catálogo, config, histórico | Postgres (gravado pelo painel) | igual |
| Cancelar link vencido / abandonar conversa | `pg_cron` → `rotina_prazos()` a cada 10 s | igual |
| Transições de status válidas, frete congelado | triggers do Postgres | igual |
| **Bot do WhatsApp** | navegador (simulador) | Edge Function / n8n |
| **Webhook do Mercado Pago** | navegador (botão do simulador) | Edge Function com validação de assinatura |
| **Geração do link de pagamento** | simulada no navegador | Edge Function (cria a preference no MP) |

Enquanto bot/webhook forem simulados, a RLS deixa o operador autenticado escrever no domínio de pedidos
(ver comentário no fim de `001_schema.sql`). Quando as Edge Functions entrarem (usam `service_role`),
tire `insert/update` de `pagamentos`, `links_pagamento`, `clientes`, `chats` e `mensagens` do papel `authenticated`.

## Operadores

Criar usuário em Authentication → Users e depois `insert into operadores (id, nome, papel) values ('<uuid>', 'Nome', 'operador');`.
Sem a linha em `operadores` o painel recusa o login.

## Limites conhecidos

- O painel carrega os 1000 pedidos e 2000 mensagens mais recentes (limite do PostgREST); relatórios longos precisam de paginação no servidor.
- O catálogo do seed é de exemplo (o real está pendente).

-- Painel Natural Sabor: schema inicial (Supabase / Postgres).
-- Dinheiro em centavos (integer). Timestamps em timestamptz.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- operadores
create table operadores (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  papel text not null default 'operador' check (papel in ('operador','admin')),
  ativo boolean not null default true
);

create function eh_operador() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from operadores o where o.id = auth.uid() and o.ativo)
$$;

-- ------------------------------------------------------------ configuracoes
create table configuracoes (
  id boolean primary key default true check (id),
  frete_minimo_cent int not null check (frete_minimo_cent > 0),
  tarifa_base_cent int not null check (tarifa_base_cent >= 0),
  valor_por_km_cent int not null check (valor_por_km_cent >= 0),
  multiplicador numeric(4,2) not null check (multiplicador between 1 and 3),
  janela_pagamento_min int not null check (janela_pagamento_min between 5 and 60),
  abandono_horas int not null check (abandono_horas between 1 and 72),
  cidades_ativas text[] not null
    check (cardinality(cidades_ativas) > 0
           and cidades_ativas <@ array['João Pessoa','Cabedelo','Bayeux'])
);

-- ----------------------------------------------------------------- catálogo
create table produtos (
  id text primary key,
  nome text not null,
  ativo boolean not null default true
);
create table sabores (
  id text primary key,
  produto_id text not null references produtos,
  nome text not null,
  ativo boolean not null default true,
  unique (produto_id, nome)
);
create table variantes (
  id text primary key,
  sabor_id text not null references sabores on delete cascade,
  rotulo text not null,
  peso_g int not null check (peso_g > 0),
  preco_cent int not null check (preco_cent > 0),
  ativo boolean not null default true,
  unique (sabor_id, rotulo)
);

create table feriados (
  data date primary key,
  nome text not null
);

-- ----------------------------------------------------------------- clientes
create table clientes (
  id uuid primary key default gen_random_uuid(),
  telefone text not null unique,
  nome text not null,
  criado_em timestamptz not null default now()
);

-- ------------------------------------------------------------------ pedidos
create sequence pedido_numero_seq start 2041;
create type pedido_status as enum
  ('conversa','nao_pago','pago','entrega','concluido','cancelado','abandonada');

create table pedidos (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique default ('P-' || nextval('pedido_numero_seq')),
  cliente_id uuid not null references clientes,
  status pedido_status not null default 'conversa',
  passo_bot text not null default 'menu',
  criado_em timestamptz not null default now(),
  etapa_desde timestamptz not null default now(),
  ultima_msg_em timestamptz not null default now(),
  endereco jsonb,
  frete jsonb,
  subtotal_cent int not null default 0 check (subtotal_cent >= 0),
  frete_cent int not null default 0 check (frete_cent >= 0),
  total_cent int not null default 0,
  entrega_tipo text check (entrega_tipo in ('hoje','agendada')),
  entrega_data date,
  acima_100kg boolean not null default false,
  alerta_tardio boolean not null default false,
  motivo text not null default '',
  check (total_cent = subtotal_cent + frete_cent)
);
create index pedidos_status_idx on pedidos (status, etapa_desde);
create index pedidos_cliente_idx on pedidos (cliente_id);
create index pedidos_criado_idx on pedidos (criado_em desc);

create table pedido_itens (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos on delete cascade,
  variante_id text not null references variantes,
  nome text not null,
  rotulo text not null,
  peso_g int not null check (peso_g > 0),
  preco_cent int not null check (preco_cent > 0),
  qtd int not null check (qtd > 0),
  ordem int not null default 0,
  unique (pedido_id, variante_id)
);

create table links_pagamento (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos,
  mp_preference_id text not null unique,
  url text not null,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  invalidado_em timestamptz
);
create index links_pedido_idx on links_pagamento (pedido_id);

create table pagamentos (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos,
  mp_payment_id text not null unique,   -- idempotência do webhook
  metodo text not null,
  valor_cent int not null check (valor_cent > 0),
  tardio boolean not null default false,
  pago_em timestamptz not null default now(),
  payload jsonb
);
create index pagamentos_pedido_idx on pagamentos (pedido_id);

create table pedido_historico (
  id bigint generated always as identity primary key,
  pedido_id uuid not null references pedidos on delete cascade,
  em timestamptz not null default now(),
  de pedido_status,
  para pedido_status not null,
  autor text not null,
  obs text not null default ''
);
create index historico_pedido_idx on pedido_historico (pedido_id, em);

-- -------------------------------------------------------------------- chat
create table chats (
  cliente_id uuid primary key references clientes,
  pedido_id uuid references pedidos,
  bot jsonb not null default '{"passo":"menu","pilha":[],"temp":{}}'
);
create table mensagens (
  id bigint generated always as identity primary key,
  cliente_id uuid not null references clientes,
  de text not null check (de in ('cliente','bot','operador')),
  texto text not null,
  em timestamptz not null default now(),
  link_pedido_id uuid references pedidos
);
create index mensagens_cliente_idx on mensagens (cliente_id, em);

-- ------------------------------------- regra: transições de status válidas
-- Vale para qualquer cliente do banco (painel, simulador, Edge Function).
create function valida_transicao_pedido() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if (old.status, new.status) in (
    ('conversa','nao_pago'), ('conversa','cancelado'), ('conversa','abandonada'),
    ('nao_pago','pago'), ('nao_pago','cancelado'),
    ('pago','entrega'), ('entrega','concluido')
  ) then
    if new.status = 'entrega'
       and new.entrega_data > (now() at time zone 'America/Fortaleza')::date then
      raise exception 'Entrega agendada para %: só sai no dia.', new.entrega_data;
    end if;
    return new;
  end if;
  raise exception 'Transição de pedido inválida: % -> %', old.status, new.status;
end $$;
create trigger pedidos_transicao before update on pedidos
  for each row execute function valida_transicao_pedido();

-- Preço e peso do item sempre > 0 já pelos checks; frete congelado após o link:
create function congela_pedido_pago() returns trigger
language plpgsql as $$
begin
  if old.status <> 'conversa' and (
       new.frete is distinct from old.frete or new.frete_cent <> old.frete_cent
       or new.subtotal_cent <> old.subtotal_cent or new.endereco is distinct from old.endereco) then
    raise exception 'Frete, endereço e valores ficam congelados depois do link de pagamento.';
  end if;
  return new;
end $$;
create trigger pedidos_congela before update on pedidos
  for each row execute function congela_pedido_pago();

-- ------------------------------------------------ rotina de prazos (cron)
-- Cancela link vencido e marca conversa abandonada. Roda no servidor, 1x/min.
create function rotina_prazos() returns void
language plpgsql security definer set search_path = public as $$
declare cfg configuracoes; r record;
begin
  select * into cfg from configuracoes;
  if not found then return; end if;

  for r in
    select p.id, p.cliente_id from pedidos p
    where p.status = 'nao_pago'
      and exists (select 1 from links_pagamento l
                  where l.pedido_id = p.id and l.invalidado_em is null and l.expira_em <= now())
    for update skip locked
  loop
    update links_pagamento set invalidado_em = now() where pedido_id = r.id and invalidado_em is null;
    update pedidos set status = 'cancelado', etapa_desde = now(), passo_bot = 'finalizado',
      motivo = 'Link expirou (' || cfg.janela_pagamento_min || ' min)' where id = r.id;
    insert into pedido_historico (pedido_id, de, para, autor, obs)
      values (r.id, 'nao_pago', 'cancelado', 'Sistema', 'Link expirou sem pagamento, link invalidado');
    insert into mensagens (cliente_id, de, texto) values (r.cliente_id, 'bot',
      E'⏱️ O prazo de ' || cfg.janela_pagamento_min || E' minutos do link acabou e o pedido foi *cancelado*.\n' ||
      E'Quando quiser, é só mandar *oi* que a gente monta de novo. 😉');
  end loop;

  for r in
    select id from pedidos
    where status = 'conversa' and ultima_msg_em <= now() - make_interval(hours => cfg.abandono_horas)
    for update skip locked
  loop
    update pedidos set status = 'abandonada', etapa_desde = now(),
      motivo = 'Conversa parada por ' || cfg.abandono_horas || ' h' where id = r.id;
    insert into pedido_historico (pedido_id, de, para, autor, obs)
      values (r.id, 'conversa', 'abandonada', 'Sistema', cfg.abandono_horas || ' h sem mensagem');
  end loop;
end $$;
revoke all on function rotina_prazos() from public, anon, authenticated;

-- ---------------------------------------------------------------------- RLS
-- Fase atual: o bot e o webhook ainda são simulados no navegador, então o
-- operador autenticado escreve no domínio de pedidos. Quando as Edge Functions
-- (bot, webhook do Mercado Pago) entrarem, tirar insert/update de
-- pagamentos, links_pagamento, clientes, chats e mensagens do papel authenticated.
do $$
declare t text;
begin
  foreach t in array array['operadores','configuracoes','produtos','sabores','variantes','feriados',
    'clientes','pedidos','pedido_itens','links_pagamento','pagamentos','pedido_historico','chats','mensagens']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to authenticated using (eh_operador())', t || '_sel', t);
  end loop;

  foreach t in array array['configuracoes','produtos','sabores','variantes','clientes','pedidos',
    'pedido_itens','links_pagamento','pagamentos','pedido_historico','chats','mensagens']
  loop
    execute format('create policy %I on %I for insert to authenticated with check (eh_operador())', t || '_ins', t);
  end loop;

  foreach t in array array['configuracoes','produtos','sabores','variantes','clientes','pedidos',
    'links_pagamento','pagamentos','chats']
  loop
    execute format('create policy %I on %I for update to authenticated using (eh_operador()) with check (eh_operador())', t || '_upd', t);
  end loop;
end $$;
-- itens são regravados junto com o pedido (só enquanto em Conversa iniciada)
create policy pedido_itens_del on pedido_itens for delete to authenticated using (
  eh_operador() and exists (select 1 from pedidos p where p.id = pedido_id and p.status = 'conversa'));
create policy pedido_itens_upd on pedido_itens for update to authenticated
  using (eh_operador()) with check (eh_operador());

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;

-- ----------------------------------------------------------------- Realtime
alter publication supabase_realtime add table pedidos, mensagens, produtos, sabores, variantes, configuracoes;

-- ------------------------------------------------------------------- seed
insert into configuracoes values (true, 1200, 500, 180, 1.10, 15, 24, array['João Pessoa','Cabedelo','Bayeux']);

insert into feriados values
 ('2026-01-01','Confraternização Universal'),('2026-04-03','Sexta-feira Santa'),('2026-04-21','Tiradentes'),
 ('2026-05-01','Dia do Trabalho'),('2026-08-05','Fundação da Paraíba'),('2026-09-07','Independência do Brasil'),
 ('2026-10-12','Nossa Senhora Aparecida'),('2026-11-02','Finados'),('2026-11-15','Proclamação da República'),
 ('2026-11-20','Consciência Negra'),('2026-12-25','Natal'),('2027-01-01','Confraternização Universal'),
 ('2027-03-26','Sexta-feira Santa'),('2027-04-21','Tiradentes'),('2027-05-01','Dia do Trabalho');

-- Catálogo de EXEMPLO (o real está pendente com o dono). 1 kg / 500 g (56%) / 250 g (32%).
insert into produtos values ('polpa','Polpa de fruta',true);
with s(id, nome, preco_kg, ativo, sem250) as (values
  ('acerola','Acerola',1600,true,false), ('caja','Cajá',2200,true,false), ('caju','Caju',1600,true,false),
  ('goiaba','Goiaba',1700,true,false), ('graviola','Graviola',3200,false,false), ('manga','Manga',1800,true,false),
  ('maracuja','Maracujá',2400,true,false), ('morango','Morango',2600,true,true), ('uva','Uva',2300,true,false),
  ('abacaxi-hortela','Abacaxi com hortelã',2000,true,false)),
ins as (insert into sabores select id,'polpa',nome,ativo from s returning id)
insert into variantes (id, sabor_id, rotulo, peso_g, preco_cent, ativo)
select s.id || '-1kg', s.id, '1 kg', 1000, s.preco_kg, true from s
union all select s.id || '-500', s.id, '500 g', 500, (round(s.preco_kg * 0.56 / 10) * 10)::int, true from s
union all select s.id || '-250', s.id, '250 g', 250, (round(s.preco_kg * 0.32 / 10) * 10)::int, not s.sem250 from s;

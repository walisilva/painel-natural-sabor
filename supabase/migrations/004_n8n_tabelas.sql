-- Tabelas do bot de pedidos do WhatsApp (n8n). Espelham o banco "clientes_controle_mensagens"
-- da VM (mesmas colunas/tipos/chaves) com o prefixo n8n_. Só o n8n (conexão Postgres / service_role)
-- acessa: RLS ligada, sem policy e sem grant para anon/authenticated.

create table n8n_clientes (
  id serial primary key,
  nome varchar(255) not null unique,
  created_at timestamp not null default now()
);

create table n8n_chat_state (
  cliente_id int not null references n8n_clientes(id),
  phone varchar not null,
  state varchar,
  fallback_count int default 0,
  updated_at timestamp default now(),
  context jsonb,
  primary key (cliente_id, phone)
);

create table n8n_cliente_nome (
  cliente_id int not null, phone varchar not null, nome text not null,
  updated_at timestamptz not null default now(),
  primary key (cliente_id, phone)
);

create table n8n_endereco_cliente (
  cliente_id int not null, phone varchar not null, endereco text not null,
  updated_at timestamptz not null default now(),
  primary key (cliente_id, phone)
);

create table n8n_contato_ultimo_visto (
  cliente_id int not null, phone varchar not null,
  ultimo_contato timestamptz, ultimo_contato_dono timestamptz,
  aviso_indisponivel_em timestamptz, aviso_pausa_vendas_em timestamptz,
  primary key (cliente_id, phone)
);

create table n8n_flags_bot (
  cliente_id int not null, chave varchar not null, valor boolean not null,
  atualizado_em timestamptz not null default now(),
  primary key (cliente_id, chave)
);

create table n8n_pedidos (
  id serial primary key,
  cliente_id int not null references n8n_clientes(id),
  phone varchar not null,
  nome_cliente varchar(255),
  itens jsonb not null,
  valor_total numeric(10,2) not null,
  forma_pagamento varchar(50),
  endereco text,
  status varchar(30) not null default 'pendente',
  created_at timestamp not null default now(),
  metodo_entrega varchar(20),
  estoque_reservas jsonb,
  valor_entrega numeric,
  detalhes_extras text
);

create table n8n_cobrancas (
  id serial primary key,
  cliente_id int not null references n8n_clientes(id),
  phone varchar not null,
  descricao text not null,
  valor numeric(10,2) not null,
  mp_preference_id text,
  mp_payment_id text,
  init_point text,
  status varchar(20) not null default 'pendente',
  created_at timestamp not null default now(),
  expires_at timestamp,
  paid_at timestamp,
  updated_at timestamp not null default now(),
  pedido_id int references n8n_pedidos(id)
);
create index idx_n8n_cobrancas_pedido on n8n_cobrancas (pedido_id);
create index idx_n8n_cobrancas_preference on n8n_cobrancas (mp_preference_id);
create index idx_n8n_cobrancas_status on n8n_cobrancas (status);

do $$
declare t text;
begin
  foreach t in array array['n8n_clientes','n8n_chat_state','n8n_cliente_nome','n8n_endereco_cliente',
    'n8n_contato_ultimo_visto','n8n_flags_bot','n8n_pedidos','n8n_cobrancas']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
revoke all on all sequences in schema public from anon;

-- Cliente deste fluxo (mesmo id 4 que o n8n já usa no banco da VM).
insert into n8n_clientes (id, nome) values (4, 'Geral Mock Pedra Tijolo');
select setval(pg_get_serial_sequence('n8n_clientes','id'), 4);

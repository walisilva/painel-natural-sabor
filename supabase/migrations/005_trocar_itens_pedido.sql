-- Troca todos os itens de um pedido numa única transação (apagar + inserir).
-- Antes o painel fazia as duas chamadas separadas: se a segunda falhasse, o pedido ficava sem itens.
-- Roda com os direitos de quem chama (security invoker), então a RLS de pedido_itens continua valendo:
-- só operador, e só enquanto o pedido está em "conversa".
create function trocar_itens_pedido(p_pedido uuid, p_itens jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  delete from pedido_itens where pedido_id = p_pedido;
  insert into pedido_itens (pedido_id, variante_id, nome, rotulo, peso_g, preco_cent, qtd, ordem)
  select p_pedido, i->>'variante_id', i->>'nome', i->>'rotulo',
         (i->>'peso_g')::int, (i->>'preco_cent')::int, (i->>'qtd')::int, (i->>'ordem')::int
  from jsonb_array_elements(p_itens) as i;
end $$;

revoke all on function trocar_itens_pedido(uuid, jsonb) from public, anon;
grant execute on function trocar_itens_pedido(uuid, jsonb) to authenticated;

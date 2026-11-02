-- Catálogo público (somente itens ATIVOS) para o bot do WhatsApp no n8n ler com a chave publishable.
-- A view roda com os direitos do dono, então não abre as tabelas: expõe só produto/sabor/tamanho/preço
-- de itens ligados no painel. Desligar um sabor/tamanho/produto no painel o tira daqui na hora.
create view catalogo_ativo as
select p.id  as produto_id, p.nome as produto,
       s.id  as sabor_id,   s.nome as sabor,
       v.id  as variante_id, v.rotulo, v.peso_g, v.preco_cent
from variantes v
join sabores  s on s.id = v.sabor_id  and s.ativo
join produtos p on p.id = s.produto_id and p.ativo
where v.ativo and v.preco_cent > 0;

revoke all on catalogo_ativo from public, anon, authenticated;
grant select on catalogo_ativo to anon, authenticated;

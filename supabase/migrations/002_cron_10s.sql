-- Rotina de prazos a cada 10 s (link de 15 min não pode ficar "vivo" até 1 min depois de vencer).
-- No Supabase o pg_cron também pode ser ligado em Database > Extensions; o comando abaixo faz o mesmo.
create extension if not exists pg_cron;

select cron.schedule('rotina-prazos-natural-sabor', '10 seconds', 'select public.rotina_prazos()');

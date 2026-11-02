# Painel Natural Sabor (protótipo)

Protótipo navegável do **painel de pedidos da Natural Sabor** (fábrica de polpas de
fruta que vende pelo WhatsApp). Mostra, de ponta a ponta, como o atendimento pelo
bot vira pedido, passa pelo pagamento e segue para a entrega, com as **regras de
negócio reais** aplicadas, mesmo sendo uma demonstração.

> **Frontend + Supabase.** Pedidos, catálogo, configurações e login ficam no Supabase
> (veja `supabase/README.md`). O **bot do WhatsApp e o webhook do Mercado Pago ainda são
> simulados** no navegador (tela *Simulador WhatsApp*); em produção viram Edge Functions.

---

## Como rodar localmente

Não há build nem dependências para instalar. Basta servir a pasta por HTTP
(abrir o `index.html` direto como `file://` quebra o carregamento dos módulos).

**Com Python (já incluso):**

```bash
python servir.py 8080
```

Depois abra <http://127.0.0.1:8080/>.

**Ou com qualquer servidor estático**, por exemplo:

```bash
npx serve .
```

### Acesso

Login pelo Supabase Auth. Os operadores são criados no painel do Supabase
(Authentication → Users) e cadastrados na tabela `operadores`. Não há credencial no repositório.

---

## Regras de negócio aplicadas

- **Frete nunca é grátis.** Veja abaixo, em [Como o frete é calculado](#como-o-frete-é-calculado),
  o que é cada parte da conta.
- **Cobertura restrita** a João Pessoa, Cabedelo e Bayeux (cada cidade pode ser
  pausada, mas nenhuma outra é aceita).
- **Entrega** hoje ou agendada em até 30 dias, sempre em **dia útil** (fim de
  semana e feriados são recusados, com sugestão do próximo dia válido).
- **Acima de 100 kg** o pedido vai para combinação manual.
- **Nada é de graça no catálogo.** Sabor novo já nasce com um tamanho e um
  preço maior que zero, e um sabor só pode ser ligado se algum tamanho tiver preço.
- **Link de pagamento (Mercado Pago)** vale 15 minutos e é cancelado
  automaticamente quando expira.
- **Pagamento após o cancelamento** não é honrado e não gera estorno automático;
  o pedido fica sinalizado para conferência manual.
- **Conversa parada por 24 h** é marcada como abandonada.
- **Kanban** com as colunas *Conversa iniciada · Não pago · Pago · Em entrega*
  (concluído sai do quadro). O operador só arrasta **Pago → Em entrega** e
  **Em entrega → Concluído**; os demais movimentos são bloqueados com o motivo.

---

## Como o frete é calculado

```
frete = max(frete_mínimo, tarifa_base + valor_por_km × km) × multiplicador
```

A conta segue o modelo de preço do Uber Envios e se lê de dentro para fora.

| Parte           | Padrão      | O que é |
| --------------- | ----------- | ------- |
| `km`            | pelo endereço | Distância pela **rota de carro** da fábrica até o cliente, como o serviço de mapa calcula (não é linha reta). No protótipo vem de uma tabela por bairro; no sistema real, de uma API de rotas. É só a forma de medir: o veículo da entrega (moto ou carro) ainda não foi definido. |
| `tarifa_base`   | R$ 5,00     | Valor fixo de toda entrega, cobrado só por sair com o pedido (como a "bandeirada" do táxi). |
| `valor_por_km`  | R$ 1,80     | Quanto cada km de rota soma ao frete. |
| `frete_mínimo`  | R$ 12,00    | Piso. Se `tarifa_base + valor_por_km × km` der menos que isso (entrega muito perto), vale o mínimo. O `max(...)` escolhe o maior dos dois. |
| `multiplicador` | 1,10        | Ajuste final aplicado sobre o resultado anterior. |

### O multiplicador

É a margem em cima do valor calculado no modelo do Uber. **1,10 significa
"valor do Uber + 10%"** (decisão de 29/10). Segundo a decisão registrada
no Trello, os 10% servem para cobrir a variação de preço do Uber Envios por
horário.

- `1,00` repassa o valor sem margem; `1,20` soma 20%; `1,10` soma 10%.
- Ele entra **por último**, então vale também em cima do frete mínimo:
  R$ 12,00 × 1,10 = R$ 13,20.
- A tela de Configurações **não aceita valor menor que 1**, para o frete nunca
  ficar abaixo do valor de referência.

### Exemplos com os valores padrão

| Destino               | km  | `tarifa_base + valor_por_km × km` | Depois do `max` | × 1,10 = **frete** |
| --------------------- | --- | --------------------------------- | --------------- | ------------------ |
| Tambiá (JP)           | 2,5 | 5,00 + 1,80 × 2,5 = R$ 9,50       | R$ 12,00 (mínimo) | **R$ 13,20**     |
| Manaíra (JP)          | 9   | 5,00 + 1,80 × 9 = R$ 21,20        | R$ 21,20        | **R$ 23,32**       |
| Intermares (Cabedelo) | 16  | 5,00 + 1,80 × 16 = R$ 33,80       | R$ 33,80        | **R$ 37,18**       |

Todos esses valores o dono muda na tela **Configurações**, que mostra a
simulação na hora. O frete é **congelado** no momento em que o link de
pagamento é gerado: mudar a configuração depois não altera pedido já feito.

---

## Telas

- **Pedidos**: Kanban com arrastar e soltar, números do dia, alertas de
  pagamento tardio e de pedidos acima do limite de peso.
- **Produtos**: catálogo por sabor e tamanho, com preço e chave ativo/inativo.
- **Relatórios**: um relatório por status, filtro por período, soma no rodapé
  (a aba *Todos* soma só o que entrou de dinheiro) e exportação em CSV.
- **Configurações**: parâmetros de frete, prazos e cidades atendidas.
- **Simulador WhatsApp**: conversa com o bot para ver um pedido nascer do zero;
  inclui um relógio de simulação para adiantar o tempo e ver os timers agirem.
- **Regras do MVP**: revisão das telas e do que fica dentro/fora do escopo.

---

## Estrutura do projeto

```
prototipo-painel/
├── index.html            # Casca do app, sprite de ícones e ordem de carga
├── servir.py             # Servidor estático local (sem cache)
├── package.json          # Scripts de teste e start (sem dependências)
├── supabase/             # Migrações SQL e README do banco
├── estilos/              # CSS por área (base, layout, pedidos, relatórios…)
├── src/
│   ├── nucleo/
│   │   ├── regras.js     # Regras de negócio puras (UMD: navegador + Node)
│   │   └── util.js       # Formatação, cópia, helpers de DOM
│   ├── dados/
│   │   ├── dados.js      # Km por bairro e CEPs offline
│   │   └── supabase.js   # Cliente Supabase
│   ├── estado/
│   │   └── estado.js     # Cache + gravação no Supabase, Realtime, sessão (Auth)
│   ├── bot/
│   │   ├── textos.js     # Falas do bot
│   │   ├── cep.js        # Consulta de CEP (ViaCEP + tabela offline)
│   │   └── bot.js        # Máquina de estados da conversa do WhatsApp
│   ├── ui/
│   │   └── ui.js         # Registro de telas, modal, toasts, loop de 1s
│   ├── telas/            # Uma tela por arquivo
│   └── main.js           # Login, menu e inicialização
└── testes/
    └── regras.test.js    # Testes das regras de negócio
```

---

## Testes

As regras de negócio têm testes com o runner nativo do Node (sem dependências):

```bash
npm test
```

---

## Notas técnicas

- **JavaScript puro, sem build nem framework.** Os módulos são IIFE registrados
  em `window.FP`.
- **Estado imutável** em cache na memória (`estado.js`), com leitura síncrona para as telas.
  Cada mudança é gravada no Supabase (só o que mudou, com coalescência) e o Realtime
  traz mudanças de outras abas e da rotina de prazos do servidor.
- **`regras.js` é UMD**: roda no navegador e também sob `node --test`.
- **CEP** consultado no ViaCEP, com tabela offline de reserva.

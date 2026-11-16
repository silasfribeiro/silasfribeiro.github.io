// SIMULAÇÃO — camada de dados FALSA, em memória, com dados fictícios.
// Nada aqui fala com servidor: tudo nasce no carregamento da página e some ao recarregar.
// Mantém as mesmas exportações do db.js do app real para o resto do código funcionar igual.

const cfg = window.APP_CONFIG || {};
export const configurado = true;

// ============================================================
// 1) Banco em memória + cliente falso
// ============================================================
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(16).slice(2) + Date.now());
const agora = () => new Date().toISOString();
const diasAtras = (n, hora = 11, min = 0) => {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(hora, min, 0, 0); return d.toISOString();
};
const diaISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

const DB = {
  categorias: [], colecoes: [], eventos: [], locais: [], produtos: [],
  vendas: [], venda_itens: [], movimentacoes: [], contagens: [], configuracoes: [],
};

const PADROES = {
  categorias: () => ({ cor: '#A6C969' }),
  locais: () => ({ ativo: true, evento_id: null }),
  produtos: () => ({ ativo: true, preco: 0, custo: 0, estoque_minimo: 0, foto_url: null, variacao: null, sku: null, observacoes: null, colecao_id: null, categoria_id: null }),
  eventos: () => ({ status: 'planejado', custo_mesa: 0, lugar: null, observacoes: null }),
  vendas: () => ({ desconto: 0, total: 0, origem: 'manual', forma_pagamento: 'pix', canal: 'atelie', observacao: null, evento_id: null, local_id: null }),
};

// Relações aninhadas usadas pelo app no select('*, rel(cols)')
const RELACOES = {
  'vendas.venda_itens': { tipo: 'muitos', tabela: 'venda_itens', fk: 'venda_id' },
  'movimentacoes.vendas': { tipo: 'um', tabela: 'vendas', fk: 'venda_id' },
};

function estoqueAtual() {
  const m = new Map();
  const soma = (p, l, q) => { if (!l) return; const k = p + '|' + l; m.set(k, (m.get(k) || 0) + q); };
  for (const x of DB.movimentacoes) { soma(x.produto_id, x.destino_id, x.quantidade); soma(x.produto_id, x.origem_id, -x.quantidade); }
  return [...m.entries()].map(([k, quantidade]) => { const [produto_id, local_id] = k.split('|'); return { produto_id, local_id, quantidade }; });
}
const linhasDe = (t) => t === 'estoque_atual' ? estoqueAtual() : DB[t];

function escolher(row, colsStr) {
  const partes = colsStr.split(',').map(s => s.trim()).filter(Boolean);
  if (!partes.length || partes.includes('*')) return { ...row };
  const o = {}; for (const c of partes) o[c] = row[c]; return o;
}

// separa "*, vendas(canal, forma_pagamento)" em colunas base + relações
function analisarSelect(str) {
  const rels = []; let base = str;
  const re = /(\w+)\(([^)]*)\)/g; let m;
  while ((m = re.exec(str))) rels.push({ nome: m[1], cols: m[2] });
  base = str.replace(re, '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim() || '*';
  return { base, rels };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

class Consulta {
  constructor(tabela) {
    this.t = tabela; this.op = 'select'; this.filtros = []; this.ordens = [];
    this.cols = '*'; this.opts = {}; this.carga = null; this.devolve = false;
    this.lim = null; this.faixa = null; this.um = null; this.feito = null;
  }
  select(cols = '*', opts = {}) { if (this.op === 'select') { this.cols = cols; this.opts = opts; } else { this.devolve = true; if (cols) this.cols = cols; } return this; }
  insert(c) { this.op = 'insert'; this.carga = c; return this; }
  update(c) { this.op = 'update'; this.carga = c; return this; }
  upsert(c) { this.op = 'upsert'; this.carga = c; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filtros.push(r => r[c] === v); return this; }
  neq(c, v) { this.filtros.push(r => r[c] !== v); return this; }
  gt(c, v) { this.filtros.push(r => r[c] > v); return this; }
  gte(c, v) { this.filtros.push(r => r[c] >= v); return this; }
  lt(c, v) { this.filtros.push(r => r[c] < v); return this; }
  lte(c, v) { this.filtros.push(r => r[c] <= v); return this; }
  in(c, vs) { this.filtros.push(r => vs.includes(r[c])); return this; }
  is(c, v) { this.filtros.push(r => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c, op, v) {
    if (op === 'is') this.filtros.push(r => (v === null ? r[c] != null : r[c] !== v));
    else if (op === 'eq') this.filtros.push(r => r[c] !== v);
    return this;
  }
  order(c, o = {}) { this.ordens.push({ c, asc: o.ascending !== false, nullsFirst: o.nullsFirst }); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.faixa = [a, b]; return this; }
  single() { this.um = 'single'; return this; }
  maybeSingle() { this.um = 'maybe'; return this; }

  _filtrar(linhas) { return linhas.filter(r => this.filtros.every(f => f(r))); }
  _ordenar(linhas) {
    if (!this.ordens.length) return linhas;
    return [...linhas].sort((a, b) => {
      for (const o of this.ordens) {
        const va = a[o.c], vb = b[o.c];
        if (va == null && vb == null) continue;
        const nulosPrimeiro = o.nullsFirst ?? !o.asc;
        if (va == null) return nulosPrimeiro ? -1 : 1;
        if (vb == null) return nulosPrimeiro ? 1 : -1;
        const r = cmp(va, vb); if (r) return o.asc ? r : -r;
      }
      return 0;
    });
  }
  _projetar(linhas) {
    const { base, rels } = analisarSelect(this.cols);
    return linhas.map(r => {
      const o = escolher(r, base);
      for (const rel of rels) {
        const def = RELACOES[this.t + '.' + rel.nome]; if (!def) continue;
        if (def.tipo === 'muitos') o[rel.nome] = DB[def.tabela].filter(x => x[def.fk] === r.id).map(x => escolher(x, rel.cols));
        else { const pai = DB[def.tabela].find(x => x.id === r[def.fk]); o[rel.nome] = pai ? escolher(pai, rel.cols) : null; }
      }
      return o;
    });
  }

  _executar() {
    const t = this.t; let data = null, count = null;
    if (this.op === 'select') {
      let linhas = this._ordenar(this._filtrar(linhasDe(t)));
      count = linhas.length;
      if (this.faixa) linhas = linhas.slice(this.faixa[0], this.faixa[1] + 1);
      if (this.lim != null) linhas = linhas.slice(0, this.lim);
      data = this.opts.head ? null : this._projetar(linhas);
      if (this.opts.count !== 'exact') count = null;
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const lote = Array.isArray(this.carga) ? this.carga : [this.carga]; const novos = [];
      for (const c of lote) {
        let existente = null;
        if (this.op === 'upsert') existente = DB[t].find(x => (c.id && x.id === c.id) || (c.chave && x.chave === c.chave));
        if (existente) { Object.assign(existente, c); novos.push(existente); continue; }
        const r = { ...(PADROES[t] ? PADROES[t]() : {}), ...c };
        if (t !== 'configuracoes' && !r.id) r.id = uid();
        if (t !== 'configuracoes' && t !== 'venda_itens' && !r.criado_em) r.criado_em = agora();
        if (t === 'vendas' && !r.data) r.data = agora();
        DB[t].push(r); novos.push(r);
        if (t === 'eventos') DB.locais.push({ id: uid(), nome: 'Evento: ' + r.nome, tipo: 'evento', evento_id: r.id, ativo: true, criado_em: agora() });
      }
      data = this.devolve ? this._projetar(novos) : null;
    } else if (this.op === 'update') {
      const alvo = this._filtrar(DB[t]);
      for (const r of alvo) {
        Object.assign(r, this.carga);
        if (t === 'eventos' && 'nome' in this.carga) { const l = DB.locais.find(x => x.evento_id === r.id); if (l) l.nome = 'Evento: ' + r.nome; }
      }
      data = this.devolve ? this._projetar(alvo) : null;
    } else if (this.op === 'delete') {
      const alvo = new Set(this._filtrar(DB[t]));
      DB[t] = DB[t].filter(r => !alvo.has(r));
      const ids = new Set([...alvo].map(r => r.id));
      if (t === 'produtos') { DB.movimentacoes = DB.movimentacoes.filter(m => !ids.has(m.produto_id)); DB.venda_itens.forEach(i => { if (ids.has(i.produto_id)) i.produto_id = null; }); }
      if (t === 'vendas') { DB.venda_itens = DB.venda_itens.filter(i => !ids.has(i.venda_id)); DB.movimentacoes = DB.movimentacoes.filter(m => !ids.has(m.venda_id)); }
      if (t === 'eventos') { const ls = new Set(DB.locais.filter(l => ids.has(l.evento_id)).map(l => l.id)); DB.locais = DB.locais.filter(l => !ls.has(l.id)); DB.movimentacoes = DB.movimentacoes.filter(m => !ls.has(m.origem_id) && !ls.has(m.destino_id)); DB.vendas.forEach(v => { if (ids.has(v.evento_id)) v.evento_id = null; }); }
    }
    if (this.um) {
      const [primeiro] = data || [];
      if (!primeiro && this.um === 'single') return { data: null, error: { message: 'Nenhuma linha encontrada' }, count };
      return { data: primeiro || null, error: null, count };
    }
    return { data, error: null, count };
  }
  then(ok, falha) {
    if (!this.feito) this.feito = Promise.resolve().then(() => this._executar());
    return this.feito.then(ok, falha);
  }
  catch(f) { return this.then(undefined, f); }
}

// ---------- funções (rpc) — espelham as do schema.sql ----------
function criarMov(m) {
  DB.movimentacoes.push({ id: uid(), venda_id: null, origem_id: null, destino_id: null, observacao: null, criado_em: agora(), ...m });
}
function rpcRegistrarVenda(p) {
  const id = uid(); const local = p.local_id || null; let total = 0;
  const v = { id, data: p.data || agora(), local_id: local, canal: p.canal || 'atelie', evento_id: p.evento_id || null, forma_pagamento: p.forma_pagamento || 'pix', desconto: Number(p.desconto) || 0, total: 0, origem: p.origem || 'manual', observacao: p.observacao || null, criado_em: p.data || agora() };
  DB.vendas.push(v);
  for (const it of p.itens || []) {
    if (!(it.quantidade > 0)) continue;
    const prod = DB.produtos.find(x => x.id === it.produto_id);
    DB.venda_itens.push({ id: uid(), venda_id: id, produto_id: it.produto_id, quantidade: it.quantidade, preco_unit: Number(it.preco_unit), custo_unit: prod ? prod.custo : 0 });
    criarMov({ produto_id: it.produto_id, tipo: 'venda', quantidade: it.quantidade, origem_id: local, venda_id: id, criado_em: v.data });
    total += it.quantidade * Number(it.preco_unit);
  }
  v.total = Math.max(total - v.desconto, 0);
  return id;
}
function rpcRegistrarMovimentos(p) {
  let n = 0;
  for (const it of p.itens || []) {
    if (!(it.quantidade > 0)) continue;
    criarMov({ produto_id: it.produto_id, tipo: p.tipo, quantidade: it.quantidade, origem_id: p.origem_id || null, destino_id: p.destino_id || null, observacao: p.observacao || null, criado_em: p.criado_em || agora() });
    n++;
  }
  return n;
}
function rpcFecharEvento(evento, destino) {
  const l = DB.locais.find(x => x.evento_id === evento); let n = 0;
  if (l) for (const e of estoqueAtual().filter(x => x.local_id === l.id && x.quantidade > 0)) {
    criarMov({ produto_id: e.produto_id, tipo: 'transferencia', quantidade: e.quantidade, origem_id: l.id, destino_id: destino, observacao: 'Fechamento do evento' }); n++;
  }
  const ev = DB.eventos.find(x => x.id === evento); if (ev) ev.status = 'fechado';
  if (l) l.ativo = false;
  return n;
}

const resposta = (data) => Promise.resolve({ data, error: null });
const USUARIO = { id: 'usuario-demo', email: 'demonstracao@yume.exemplo' };

export const sb = {
  from: (t) => new Consulta(t),
  rpc: (nome, args = {}) => {
    try {
      if (nome === 'registrar_venda') return resposta(rpcRegistrarVenda(args.p));
      if (nome === 'registrar_movimentos') return resposta(rpcRegistrarMovimentos(args.p));
      if (nome === 'fechar_evento') return resposta(rpcFecharEvento(args.p_evento, args.p_destino));
      if (nome === 'notificar_teste') return resposta(null);
    } catch (e) { return Promise.resolve({ data: null, error: { message: e.message } }); }
    return Promise.resolve({ data: null, error: { message: 'Função indisponível na simulação' } });
  },
  auth: {
    getSession: () => resposta({ session: { user: USUARIO } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() { } } } }),
    getUser: () => resposta({ user: USUARIO }),
    signInWithPassword: () => Promise.resolve({ data: { session: { user: USUARIO } }, error: null }),
    signOut: () => Promise.resolve({ error: null }), // desativado na simulação
    updateUser: () => Promise.resolve({ data: { user: USUARIO }, error: null }),
  },
  storage: {
    from: () => ({
      upload: async (nome) => ({ data: { path: nome }, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: '' } }),
    }),
  },
};

// ============================================================
// 2) Dados fictícios (tudo inventado; datas relativas a hoje)
// ============================================================
// gerador pseudo-aleatório com semente fixa: a simulação é sempre igual
let semente = 20260;
const aleatorio = () => { semente = (semente * 1664525 + 1013904223) % 4294967296; return semente / 4294967296; };
const sorteia = (lista) => lista[Math.floor(aleatorio() * lista.length)];

// foto de mentira: quadrado colorido com a silhueta do produto (SVG embutido, sem arquivo nem rede)
function fotoFalsa(tipo, cor) {
  const formas = {
    vela: `<rect x="62" y="70" width="76" height="86" rx="10" fill="#fff" fill-opacity=".85"/><rect x="96" y="44" width="8" height="26" rx="3" fill="#fff" fill-opacity=".85"/><ellipse cx="100" cy="36" rx="7" ry="11" fill="#FEE398"/>`,
    sabonete: `<rect x="48" y="78" width="104" height="58" rx="18" fill="#fff" fill-opacity=".85"/><circle cx="76" cy="107" r="6" fill="${cor}" fill-opacity=".6"/><circle cx="104" cy="100" r="4" fill="${cor}" fill-opacity=".6"/><circle cx="126" cy="112" r="5" fill="${cor}" fill-opacity=".6"/>`,
    difusor: `<rect x="72" y="86" width="56" height="72" rx="14" fill="#fff" fill-opacity=".85"/><rect x="92" y="70" width="16" height="18" rx="3" fill="#fff" fill-opacity=".85"/><path d="M100 70 L84 30 M100 70 L100 24 M100 70 L116 30" stroke="#fff" stroke-opacity=".85" stroke-width="5" stroke-linecap="round"/>`,
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${cor}"/><stop offset="1" stop-color="${cor}" stop-opacity=".55"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/>${formas[tipo]}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function semear() {
  // categorias e coleções
  const cats = { vela: uid(), sabonete: uid(), difusor: uid() };
  DB.categorias.push(
    { id: cats.vela, nome: 'Velas aromáticas', cor: '#FEE398', criado_em: diasAtras(60) },
    { id: cats.sabonete, nome: 'Sabonetes', cor: '#A6C969', criado_em: diasAtras(60) },
    { id: cats.difusor, nome: 'Difusores', cor: '#CADBB7', criado_em: diasAtras(60) },
  );
  const col = { jardim: uid(), tarde: uid() };
  DB.colecoes.push(
    { id: col.jardim, nome: 'Jardim de Inverno', descricao: 'Aromas verdes e frescos', criado_em: diasAtras(60) },
    { id: col.tarde, nome: 'Fim de Tarde', descricao: 'Aromas quentes e doces', criado_em: diasAtras(60) },
  );

  // locais fixos
  const A = { id: uid(), nome: 'Estoque principal', tipo: 'atelie', ativo: true, evento_id: null, criado_em: diasAtras(60) };
  const B = { id: uid(), nome: 'Box Centro', tipo: 'box', ativo: true, evento_id: null, criado_em: diasAtras(60) };
  DB.locais.push(A, B);

  // eventos (o local de cada um nasce pela mesma regra do banco: via insert)
  const evFechado = { id: uid(), nome: 'Feira do Bairro', lugar: 'Praça Central', data_inicio: diaISO(12), data_fim: diaISO(10), custo_mesa: 80, status: 'fechado', observacoes: null, criado_em: diasAtras(25) };
  const evAberto = { id: uid(), nome: 'Mercado de Natal', lugar: 'Galpão das Artes', data_inicio: diaISO(2), data_fim: diaISO(-3), custo_mesa: 120, status: 'aberto', observacoes: null, criado_em: diasAtras(10) };
  const evPlanejado = { id: uid(), nome: 'Feira de Verão', lugar: 'Parque da Cidade', data_inicio: diaISO(-20), data_fim: diaISO(-21), custo_mesa: 90, status: 'planejado', observacoes: null, criado_em: diasAtras(5) };
  DB.eventos.push(evFechado, evAberto, evPlanejado);
  const localEv = {};
  for (const e of DB.eventos) {
    const l = { id: uid(), nome: 'Evento: ' + e.nome, tipo: 'evento', evento_id: e.id, ativo: e.status !== 'fechado', criado_em: e.criado_em };
    DB.locais.push(l); localEv[e.id] = l;
  }

  // produtos: [nome, sku, tipo, coleção, variação, preço, custo, mínimo, cor, entrada inicial]
  const lista = [
    ['Vela Lavanda 180 g', 'VL-001', 'vela', 'jardim', 'Lavanda', 58, 21, 6, '#B9A6D8', 40],
    ['Vela Eucalipto 180 g', 'VL-002', 'vela', 'jardim', 'Eucalipto', 58, 21, 6, '#8FC9A8', 36],
    ['Vela Capim-limão 180 g', 'VL-003', 'vela', 'jardim', 'Capim-limão', 58, 21, 6, '#D7E08A', 30],
    ['Vela Baunilha 180 g', 'VL-004', 'vela', 'tarde', 'Baunilha', 62, 23, 6, '#F2D7A6', 34],
    ['Vela Canela e Laranja 180 g', 'VL-005', 'vela', 'tarde', 'Canela e Laranja', 62, 23, 6, '#F2B27A', 12],
    ['Vela Mini Trio', 'VL-010', 'vela', null, 'Sortidas', 69, 27, 5, '#E6B8C8', 22],
    ['Sabonete Argila Verde', 'SB-001', 'sabonete', 'jardim', 'Argila verde', 18, 5.5, 10, '#A6C969', 60],
    ['Sabonete Aveia e Mel', 'SB-002', 'sabonete', 'tarde', 'Aveia e mel', 18, 5.5, 10, '#F0CF8E', 54],
    ['Sabonete Lavanda', 'SB-003', 'sabonete', 'jardim', 'Lavanda', 18, 5.5, 10, '#C6B4E3', 50],
    ['Sabonete Rosas', 'SB-004', 'sabonete', null, 'Rosas', 20, 6.2, 10, '#F0B6C6', 46],
    ['Sabonete Cúrcuma', 'SB-005', 'sabonete', 'tarde', 'Cúrcuma', 19, 5.8, 10, '#F2C14E', 15],
    ['Difusor Bambu 250 ml', 'DF-001', 'difusor', 'jardim', 'Bambu', 72, 26, 4, '#9CCFB8', 26],
    ['Difusor Flor de Laranjeira 250 ml', 'DF-002', 'difusor', 'tarde', 'Flor de laranjeira', 72, 26, 4, '#F4C99A', 24],
    ['Difusor Lavanda 100 ml', 'DF-003', 'difusor', 'jardim', 'Lavanda', 49, 17, 4, '#B6A4DA', 28],
    ['Difusor Âmbar 100 ml', 'DF-004', 'difusor', 'tarde', 'Âmbar', 49, 17, 4, '#E7B67E', 8],
    ['Kit Presente Relax', 'KT-001', 'vela', null, 'Vela + sabonete', 89, 33, 3, '#CFE0C0', 18],
  ];
  const prods = lista.map(([nome, sku, tipo, c, variacao, preco, custo, minimo, cor]) => {
    const p = { id: uid(), nome, sku, categoria_id: cats[tipo], colecao_id: c ? col[c] : null, variacao, preco, custo, estoque_minimo: minimo, foto_url: fotoFalsa(tipo, cor), ativo: true, observacoes: null, criado_em: diasAtras(55) };
    DB.produtos.push(p); return p;
  });

  // movimentos de estoque
  const mov = (p, tipo, q, o, d, quando, obs) => criarMov({ produto_id: p.id, tipo, quantidade: q, origem_id: o, destino_id: d, criado_em: quando, observacao: obs || null });
  prods.forEach((p, i) => {
    const ini = lista[i][9];
    mov(p, 'entrada', ini + 18, null, A.id, diasAtras(40, 9), 'Produção');                     // produção inicial
    if (i % 3 === 0) mov(p, 'entrada', 14, null, A.id, diasAtras(18, 10), 'Produção');          // reposição
  });
  // box: abastecido com a maioria
  prods.forEach((p, i) => { if (i !== 5 && i !== 14) mov(p, 'transferencia', 8 + (i % 4) * 2, A.id, B.id, diasAtras(31, 10), 'Abastecimento do box'); });
  // evento fechado: levou 8 produtos, voltou o que sobrou no fechamento
  const levouFechado = [0, 1, 3, 6, 7, 9, 11, 13];
  levouFechado.forEach(i => mov(prods[i], 'transferencia', 10, A.id, localEv[evFechado.id].id, diasAtras(13, 8), 'Levado para a feira'));
  // evento aberto: levou 9 produtos
  const levouAberto = [0, 2, 3, 4, 6, 8, 10, 12, 14];
  levouAberto.forEach(i => mov(prods[i], 'transferencia', 9, A.id, localEv[evAberto.id].id, diasAtras(3, 8), 'Levado para o mercado'));

  // vendas: ~26 nos últimos 30 dias, em ordem cronológica, sempre respeitando o saldo do local
  const saldo = (pid, lid) => estoqueAtual().find(e => e.produto_id === pid && e.local_id === lid)?.quantidade || 0;
  const pagamentos = ['pix', 'pix', 'credito', 'debito', 'dinheiro', 'pix'];
  const plano = [];
  const dias = [29, 27, 26, 24, 22, 21, 19, 17, 16, 15, 14, 12, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1, 0];
  dias.forEach((d, i) => {
    let canal = ['atelie', 'box', 'online', 'box', 'atelie'][i % 5];
    if (d === 12 || d === 11 || d === 10) canal = 'evento-fechado';
    if (d <= 2 && i % 2 === 0) canal = 'evento-aberto';
    plano.push({ d, canal });
  });
  for (const v of plano) {
    const local = v.canal === 'evento-fechado' ? localEv[evFechado.id] : v.canal === 'evento-aberto' ? localEv[evAberto.id] : v.canal === 'box' ? B : A;
    const canal = v.canal.startsWith('evento') ? 'evento' : v.canal;
    const evento = v.canal === 'evento-fechado' ? evFechado.id : v.canal === 'evento-aberto' ? evAberto.id : null;
    const itens = []; const n = 1 + Math.floor(aleatorio() * 3);
    for (let k = 0; k < n; k++) {
      const p = sorteia(prods); const ja = itens.find(x => x.produto_id === p.id); if (ja) continue;
      const q = 1 + Math.floor(aleatorio() * 2);
      if (saldo(p.id, local.id) - (ja ? ja.quantidade : 0) >= q) itens.push({ produto_id: p.id, quantidade: q, preco_unit: p.preco });
    }
    if (!itens.length) continue;
    const hora = 10 + Math.floor(aleatorio() * 8);
    rpcRegistrarVenda({ data: diasAtras(v.d, hora, Math.floor(aleatorio() * 60)), local_id: local.id, canal, evento_id: evento, forma_pagamento: sorteia(pagamentos), origem: canal === 'box' ? 'contagem' : 'manual', itens });
  }
  // a feira acabou: o que sobrou volta para o estoque principal
  const sobrou = estoqueAtual().filter(e => e.local_id === localEv[evFechado.id].id && e.quantidade > 0);
  sobrou.forEach(e => mov(DB.produtos.find(p => p.id === e.produto_id), 'transferencia', e.quantidade, localEv[evFechado.id].id, A.id, diasAtras(9, 18), 'Fechamento do evento'));

  // contagem do box
  DB.contagens.push({ id: uid(), local_id: B.id, venda_id: null, itens_vendidos: 11, total: 482, observacao: null, criado_em: diasAtras(6, 17) });

  DB.configuracoes.push(
    { chave: 'box_aluguel', valor: 150 }, { chave: 'box_comissao_pct', valor: 10 }, { chave: 'encalhado_dias', valor: 30 },
  );
}
semear();

// ============================================================
// 3) Exportações iguais às do db.js original
// ============================================================
export const S = { categorias: [], colecoes: [], locais: [], produtos: [], estoque: [], eventos: [], config: {} };

export async function q(p) {
  const { data, error } = await p;
  if (error) { console.error(error); throw new Error(error.message || 'Erro no banco de dados'); }
  return data;
}

export async function todos(build) {
  const out = []; const passo = 1000;
  for (let i = 0; ; i += passo) {
    const lote = await q(build().range(i, i + passo - 1));
    out.push(...lote);
    if (lote.length < passo) break;
  }
  return out;
}

export async function carregarTudo() {
  const [categorias, colecoes, locais, produtos, estoque, eventos, conf] = await Promise.all([
    q(sb.from('categorias').select('*').order('nome')),
    q(sb.from('colecoes').select('*').order('nome')),
    q(sb.from('locais').select('*').order('criado_em')),
    todos(() => sb.from('produtos').select('*').order('nome')),
    todos(() => sb.from('estoque_atual').select('*')),
    q(sb.from('eventos').select('*').order('data_inicio', { ascending: false, nullsFirst: false })),
    q(sb.from('configuracoes').select('*')),
  ]);
  Object.assign(S, { categorias, colecoes, locais, produtos, estoque, eventos });
  S.config = Object.fromEntries(conf.map(c => [c.chave, c.valor]));
}
export async function recarregarEstoque() {
  S.estoque = await todos(() => sb.from('estoque_atual').select('*'));
}
export async function recarregarProdutos() {
  S.produtos = await todos(() => sb.from('produtos').select('*').order('nome'));
}

// ---------- Consultas em memória ----------
export const cat = id => S.categorias.find(c => c.id === id);
export const col = id => S.colecoes.find(c => c.id === id);
export const loc = id => S.locais.find(l => l.id === id);
export const prod = id => S.produtos.find(p => p.id === id);
export const atelie = () => S.locais.find(l => l.tipo === 'atelie' && l.ativo !== false) || S.locais.find(l => l.tipo === 'atelie');
export const box = () => S.locais.find(l => l.tipo === 'box' && l.ativo !== false) || S.locais.find(l => l.tipo === 'box');
export const locaisFixos = () => S.locais.filter(l => l.tipo !== 'evento' && l.ativo !== false);
export const localDoEvento = evId => S.locais.find(l => l.evento_id === evId);

export function est(produtoId, localId) {
  const r = S.estoque.find(e => e.produto_id === produtoId && e.local_id === localId);
  return r ? r.quantidade : 0;
}
export function estTotal(produtoId) {
  return S.estoque.filter(e => e.produto_id === produtoId).reduce((s, e) => s + e.quantidade, 0);
}
export function estPorLocal(produtoId) {
  return S.estoque.filter(e => e.produto_id === produtoId && e.quantidade !== 0)
    .map(e => ({ local: loc(e.local_id), quantidade: e.quantidade }))
    .filter(x => x.local);
}
// Produto com estoque baixo em algum local fixo (ou no total)
export function estoqueBaixo(p) {
  if (!p.ativo || !p.estoque_minimo) return false;
  return estTotal(p.id) <= p.estoque_minimo;
}
export function produtosNoLocal(localId) {
  return S.estoque.filter(e => e.local_id === localId && e.quantidade > 0).map(e => ({ p: prod(e.produto_id), q: e.quantidade })).filter(x => x.p);
}

// ---------- Vendas ----------
export async function vendasPeriodo(ini, fim, extra = (b) => b) {
  return todos(() => extra(sb.from('vendas').select('*, venda_itens(*)')
    .gte('data', ini.toISOString()).lt('data', fim.toISOString())
    .order('data', { ascending: false })));
}
export const canalNome = { atelie: 'Venda direta', box: 'Box', evento: 'Evento', online: 'Loja online', outro: 'Outro' };
export const pagNome = { pix: 'Pix', dinheiro: 'Dinheiro', credito: 'Crédito', debito: 'Débito', outro: 'Outro' };
export function canalDoLocal(l) {
  if (!l) return 'atelie';
  return l.tipo === 'box' ? 'box' : l.tipo === 'evento' ? 'evento' : l.tipo === 'atelie' ? 'atelie' : 'outro';
}

export async function salvarConfig(chave, valor) {
  await q(sb.from('configuracoes').upsert({ chave, valor }));
  S.config[chave] = valor;
}
export const confNum = (k, def = 0) => { const v = S.config[k]; const n = Number(v); return isNaN(n) ? def : n; };

export async function uploadFoto(blob) {
  // na simulação a foto não vai para lugar nenhum: usa o próprio arquivo na memória do navegador
  return URL.createObjectURL(blob);
}

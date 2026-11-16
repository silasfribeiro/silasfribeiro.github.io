// SIMULAÇÃO — notificações desativadas (nada é carregado da internet nem enviado).
export const pushConfigurado = () => false;
export function iniciarPush() { return Promise.resolve(null); }
export async function statusPush() { return 'indisponivel'; }
export async function ativarPush() { throw new Error('Notificações não existem na simulação'); }
export async function desativarPush() { }

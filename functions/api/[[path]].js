/**
 * API DO SISTEMA DE OFERTAS — versão Cloudflare Pages Functions
 * ----------------------------------------------------------------
 * Este arquivo vai na pasta: functions/api/[[path]].js
 * dentro do repositório NOVO e SEPARADO deste sistema de ofertas
 * (não tem nenhuma relação com o repositório do invictorcliques).
 *
 * O Cloudflare Pages detecta automaticamente qualquer arquivo dentro de
 * `functions/` e transforma em uma rota de API - não precisa configurar
 * nada extra além de colocar o arquivo no lugar certo e subir pelo GitHub.
 *
 * Todas as rotas exigem o header:
 *   Authorization: Bearer SUA_CHAVE
 * (ADMIN_WRITE_KEY para uso no painel, BOT_API_KEY para os robôs)
 */

const TTL_HISTORICO_SEGUNDOS = 36000; // 10 horas

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const isRotaDoRobo = path.startsWith("/api/fila") || path.startsWith("/api/status");

  if (isRotaDoRobo) {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.replace("Bearer ", "");
    if (token !== env.BOT_API_KEY) return jsonResponse({ erro: "não autorizado" }, 401);
  } else {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.replace("Bearer ", "");
    if (token !== env.ADMIN_WRITE_KEY) return jsonResponse({ erro: "não autorizado" }, 401);
  }

  // ---------- OFERTAS ----------

  if (path === "/api/ofertas" && method === "POST") {
    const body = await request.json();
    const id = "oferta_" + Date.now();

    const oferta = {
      id,
      titulo: body.titulo,
      loja: body.loja,
      preco: body.preco || null,
      cupom: body.cupom || null,
      link_afiliado: body.link_afiliado,
      link_original: body.link_original || null,
      imagem: body.imagem || null,
      urgencia: body.urgencia || "normal",
      destinos: body.destinos || ["telegram", "whatsapp"],
      grupos_selecionados: body.grupos_selecionados || [],
      marcar_todos: body.marcar_todos || false,
      status: body.status || (body.agendado_para ? "agendado" : "pendente"),
      agendado_para: body.agendado_para || null,
      criado_em: new Date().toISOString(),
      origem: body.origem || "manual",
    };

    await env.OFERTAS_KV.put(`oferta:${id}`, JSON.stringify(oferta), {
      expirationTtl: TTL_HISTORICO_SEGUNDOS,
    });

    await env.OFERTAS_KV.put(
      `log:${id}`,
      JSON.stringify({
        oferta_id: id,
        site: "pendente",
        telegram_real: "pendente",
        telegram_teste: "pendente",
        whatsapp_grupos: "pendente",
        whatsapp_teste: "pendente",
        falhas: [],
      }),
      { expirationTtl: TTL_HISTORICO_SEGUNDOS }
    );

    return jsonResponse({ ok: true, oferta });
  }

  if (path === "/api/ofertas" && method === "GET") {
    const lista = await env.OFERTAS_KV.list({ prefix: "oferta:" });
    const ofertas = await Promise.all(
      lista.keys.map(async (k) => JSON.parse(await env.OFERTAS_KV.get(k.name)))
    );
    return jsonResponse({ ofertas });
  }

  if (path.match(/^\/api\/ofertas\/[\w-]+$/) && method === "PUT") {
    const id = path.split("/")[3];
    const raw = await env.OFERTAS_KV.get(`oferta:${id}`);
    if (!raw) return jsonResponse({ erro: "oferta não encontrada" }, 404);

    const ofertaAtual = JSON.parse(raw);
    const body = await request.json();

    const ofertaAtualizada = {
      ...ofertaAtual,
      titulo: body.titulo ?? ofertaAtual.titulo,
      loja: body.loja ?? ofertaAtual.loja,
      preco: body.preco ?? ofertaAtual.preco,
      cupom: body.cupom ?? ofertaAtual.cupom,
      link_afiliado: body.link_afiliado ?? ofertaAtual.link_afiliado,
      imagem: body.imagem ?? ofertaAtual.imagem,
      urgencia: body.urgencia ?? ofertaAtual.urgencia,
      grupos_selecionados: body.grupos_selecionados ?? ofertaAtual.grupos_selecionados,
      destinos: body.destinos ?? ofertaAtual.destinos,
      marcar_todos: body.marcar_todos ?? ofertaAtual.marcar_todos,
      agendado_para: body.agendado_para ?? ofertaAtual.agendado_para,
      status: body.reenviar ? "pendente" : ofertaAtual.status,
    };

    await env.OFERTAS_KV.put(`oferta:${id}`, JSON.stringify(ofertaAtualizada), {
      expirationTtl: TTL_HISTORICO_SEGUNDOS,
    });

    return jsonResponse({ ok: true, oferta: ofertaAtualizada });
  }

  if (path.match(/^\/api\/ofertas\/[\w-]+\/publicar$/) && method === "POST") {
    const id = path.split("/")[3];
    const raw = await env.OFERTAS_KV.get(`oferta:${id}`);
    if (!raw) return jsonResponse({ erro: "oferta não encontrada" }, 404);

    const oferta = JSON.parse(raw);
    oferta.status = "pendente";
    oferta.agendado_para = null;

    await env.OFERTAS_KV.put(`oferta:${id}`, JSON.stringify(oferta), {
      expirationTtl: TTL_HISTORICO_SEGUNDOS,
    });

    return jsonResponse({ ok: true });
  }

  // ---------- FILA ----------

  if (path === "/api/fila" && method === "GET") {
    const agora = new Date().toISOString();
    const lista = await env.OFERTAS_KV.list({ prefix: "oferta:" });
    const todas = await Promise.all(
      lista.keys.map(async (k) => JSON.parse(await env.OFERTAS_KV.get(k.name)))
    );

    const prontasParaEnvio = todas.filter((o) => {
      if (o.status === "pendente") return true;
      if (o.status === "agendado" && o.agendado_para && o.agendado_para <= agora) return true;
      return false;
    });

    return jsonResponse({ fila: prontasParaEnvio });
  }

  if (path.match(/^\/api\/status\/[\w-]+$/) && method === "POST") {
    const id = path.split("/")[3];
    const body = await request.json();

    const logRaw = await env.OFERTAS_KV.get(`log:${id}`);
    if (!logRaw) return jsonResponse({ erro: "log não encontrado" }, 404);

    const log = JSON.parse(logRaw);
    log[body.canal] = body.resultado;
    if (body.resultado === "falhou") {
      log.falhas.push({ canal: body.canal, detalhe: body.detalhe || null, em: new Date().toISOString() });
    }

    await env.OFERTAS_KV.put(`log:${id}`, JSON.stringify(log), {
      expirationTtl: TTL_HISTORICO_SEGUNDOS,
    });

    const todosCanais = ["site", "telegram_real", "telegram_teste", "whatsapp_grupos", "whatsapp_teste"];
    const todosConfirmados = todosCanais.every((c) => log[c] === "confirmado");

    if (todosConfirmados) {
      const ofertaRaw = await env.OFERTAS_KV.get(`oferta:${id}`);
      if (ofertaRaw) {
        const oferta = JSON.parse(ofertaRaw);
        oferta.status = "publicado";
        await env.OFERTAS_KV.put(`oferta:${id}`, JSON.stringify(oferta), {
          expirationTtl: TTL_HISTORICO_SEGUNDOS,
        });
      }
    }

    return jsonResponse({ ok: true });
  }

  if (path.match(/^\/api\/status\/[\w-]+$/) && method === "GET") {
    const id = path.split("/")[3];
    const logRaw = await env.OFERTAS_KV.get(`log:${id}`);
    if (!logRaw) return jsonResponse({ erro: "log não encontrado" }, 404);
    return jsonResponse(JSON.parse(logRaw));
  }

  // ---------- GRUPOS ----------

  if (path === "/api/grupos" && method === "GET") {
    const lista = await env.OFERTAS_KV.list({ prefix: "grupo:" });
    const grupos = await Promise.all(
      lista.keys.map(async (k) => JSON.parse(await env.OFERTAS_KV.get(k.name)))
    );
    return jsonResponse({ grupos });
  }

  if (path === "/api/grupos" && method === "POST") {
    const body = await request.json();
    const id = body.id || body.nome.toLowerCase().replace(/\s+/g, "_");

    const grupo = {
      id,
      nome: body.nome,
      plataforma: body.plataforma,
      categoria: body.categoria || null,
      status: body.status || "ativo",
      ultimo_envio: null,
      total_membros: body.total_membros || null,
      e_grupo_teste: body.e_grupo_teste || false,
      whatsapp_id: body.whatsapp_id || null,
      telegram_chat_id: body.telegram_chat_id || null,
    };

    await env.OFERTAS_KV.put(`grupo:${id}`, JSON.stringify(grupo));
    return jsonResponse({ ok: true, grupo });
  }

  if (path.match(/^\/api\/grupos\/[\w-]+\/status$/) && method === "POST") {
    const id = path.split("/")[3];
    const body = await request.json();
    const raw = await env.OFERTAS_KV.get(`grupo:${id}`);
    if (!raw) return jsonResponse({ erro: "grupo não encontrado" }, 404);
    const grupo = JSON.parse(raw);
    grupo.status = body.status;
    await env.OFERTAS_KV.put(`grupo:${id}`, JSON.stringify(grupo));
    return jsonResponse({ ok: true });
  }

  if (path.match(/^\/api\/grupos\/[\w-]+\/marcar-todos-uso$/) && method === "GET") {
    const id = path.split("/")[3];
    const raw = await env.OFERTAS_KV.get(`marcartodos:${id}`);
    const registro = raw ? JSON.parse(raw) : { grupo_id: id, usos_essa_semana: 0, ultimo_uso: null };
    return jsonResponse(registro);
  }

  if (path.match(/^\/api\/grupos\/[\w-]+\/marcar-todos-uso$/) && method === "POST") {
    const id = path.split("/")[3];
    const raw = await env.OFERTAS_KV.get(`marcartodos:${id}`);
    const registro = raw ? JSON.parse(raw) : { grupo_id: id, usos_essa_semana: 0, ultimo_uso: null };
    registro.usos_essa_semana += 1;
    registro.ultimo_uso = new Date().toISOString();
    await env.OFERTAS_KV.put(`marcartodos:${id}`, JSON.stringify(registro), { expirationTtl: 604800 });
    return jsonResponse({ ok: true, registro });
  }

  // ---------- LOJAS ----------

  if (path === "/api/lojas" && method === "GET") {
    const lista = await env.OFERTAS_KV.list({ prefix: "loja:" });
    const lojas = await Promise.all(
      lista.keys.map(async (k) => JSON.parse(await env.OFERTAS_KV.get(k.name)))
    );
    return jsonResponse({ lojas });
  }

  if (path === "/api/lojas" && method === "POST") {
    const body = await request.json();
    const id = body.id || body.nome.toLowerCase().replace(/\s+/g, "_");

    const loja = {
      id,
      nome: body.nome,
      hashtag: body.hashtag,
      dominios: body.dominios || [],
      grupos_padrao_bot: body.grupos_padrao_bot || [],
    };

    await env.OFERTAS_KV.put(`loja:${id}`, JSON.stringify(loja));
    return jsonResponse({ ok: true, loja });
  }

  return jsonResponse({ erro: "rota não encontrada" }, 404);
}

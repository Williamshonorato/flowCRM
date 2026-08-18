import { Router } from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const DEFAULT_STUCK_DAYS = 7
const MIN_STUCK_DAYS = 1
const MAX_STUCK_DAYS = 90
const ORIGIN_LABELS = { whatsapp: 'WhatsApp', indicacao: 'Indicação', instagram: 'Instagram', google_ads: 'Google Ads', outro: 'Outros' }

function fmtBRL(value) {
  return 'R$ ' + Math.round(value).toLocaleString('pt-BR')
}

function parseStageChange(content) {
  const m = content.match(/de "(.+?)" para "(.+?)"/)
  return m ? { from: m[1], to: m[2] } : null
}

// Conta, por etapa de origem, quantas mudanças de etapa saíram dela e para onde foram
function transitionStats(activities, stageNames) {
  const stats = {}
  stageNames.forEach(name => { stats[name] = { out: 0, next: {} } })
  activities.forEach(a => {
    const p = parseStageChange(a.content)
    if (!p || !stats[p.from]) return
    stats[p.from].out++
    stats[p.from].next[p.to] = (stats[p.from].next[p.to] || 0) + 1
  })
  return stats
}

function periodRange(period, now) {
  if (period === 'quarter') {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3
    return {
      start: new Date(now.getFullYear(), qStartMonth, 1),
      prevStart: new Date(now.getFullYear(), qStartMonth - 3, 1),
      prevEnd: new Date(now.getFullYear(), qStartMonth, 0, 23, 59, 59),
    }
  }
  if (period === 'year') {
    return {
      start: new Date(now.getFullYear(), 0, 1),
      prevStart: new Date(now.getFullYear() - 1, 0, 1),
      prevEnd: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59),
    }
  }
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    prevStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    prevEnd: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59),
  }
}

// GET /reports?period=month|quarter|year&stuckDays=7
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const { period = 'month' } = req.query
  const now = new Date()
  const { start: periodStart, prevStart, prevEnd } = periodRange(period, now)

  const parsedStuckDays = parseInt(req.query.stuckDays, 10)
  const stuckDays = Number.isFinite(parsedStuckDays)
    ? Math.min(MAX_STUCK_DAYS, Math.max(MIN_STUCK_DAYS, parsedStuckDays))
    : DEFAULT_STUCK_DAYS
  const stuckThreshold = new Date(now.getTime() - stuckDays * 24 * 60 * 60 * 1000)

  const [
    allDeals, closedDeals, contacts, stuckDeals,
    curStageChanges, prevStageChanges, allContacts,
    prevAllDeals, prevClosedDeals, prevActiveContactIds, totalContacts,
    stages, topDeals,
  ] = await Promise.all([
    prisma.deal.findMany({ where: { tenantId, createdAt: { gte: periodStart } }, select: { value: true, closedAt: true, stageId: true } }),
    prisma.deal.findMany({ where: { tenantId, closedAt: { gte: periodStart } }, select: { value: true, createdAt: true, closedAt: true } }),
    prisma.contact.findMany({ where: { tenantId, createdAt: { gte: periodStart } }, select: { origin: true } }),
    prisma.deal.findMany({ where: { tenantId, closedAt: null, updatedAt: { lt: stuckThreshold } }, select: { value: true, stageId: true } }),
    prisma.activity.findMany({ where: { tenantId, type: 'stage_change', createdAt: { gte: periodStart } }, select: { content: true } }),
    prisma.activity.findMany({ where: { tenantId, type: 'stage_change', createdAt: { gte: prevStart, lte: prevEnd } }, select: { content: true } }),
    prisma.contact.findMany({ where: { tenantId }, select: { origin: true, deals: { select: { closedAt: true } } } }),
    prisma.deal.findMany({ where: { tenantId, createdAt: { gte: prevStart, lte: prevEnd } }, select: { closedAt: true } }),
    prisma.deal.findMany({ where: { tenantId, closedAt: { gte: prevStart, lte: prevEnd } }, select: { value: true, createdAt: true, closedAt: true } }),
    prisma.activity.findMany({ where: { tenantId, createdAt: { gte: prevStart, lte: prevEnd } }, select: { contactId: true }, distinct: ['contactId'] }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.stage.findMany({ where: { tenantId }, orderBy: { order: 'asc' }, include: { deals: { select: { value: true } } } }),
    prisma.deal.findMany({ where: { tenantId }, orderBy: { value: 'desc' }, take: 5, include: { contact: { select: { name: true } }, stage: { select: { name: true } } } }),
  ])

  // ── KPIs (período atual vs período anterior) ──────────────────────────────
  const revenue = closedDeals.reduce((s, d) => s + Number(d.value), 0)
  const totalCreated = allDeals.length
  const totalClosed  = allDeals.filter(d => d.closedAt).length
  const conversion   = totalCreated > 0 ? (totalClosed / totalCreated) * 100 : 0
  const cycleDays = closedDeals.length
    ? Math.max(0, Math.round(closedDeals.reduce((s, d) => s + (d.closedAt - d.createdAt) / 86400000, 0) / closedDeals.length))
    : null

  const prevRevenue = prevClosedDeals.reduce((s, d) => s + Number(d.value), 0)
  const prevTotalCreated = prevAllDeals.length
  const prevTotalClosed  = prevAllDeals.filter(d => d.closedAt).length
  const prevConversion   = prevTotalCreated > 0 ? (prevTotalClosed / prevTotalCreated) * 100 : 0
  const prevCycleDays = prevClosedDeals.length
    ? Math.max(0, Math.round(prevClosedDeals.reduce((s, d) => s + (d.closedAt - d.createdAt) / 86400000, 0) / prevClosedDeals.length))
    : null
  const prevChurn = totalContacts > 0 ? ((totalContacts - prevActiveContactIds.length) / totalContacts) * 100 : 0

  const activeContactIds = await prisma.activity.findMany({ where: { tenantId, createdAt: { gte: periodStart } }, select: { contactId: true }, distinct: ['contactId'] })
  const churn = totalContacts > 0 ? ((totalContacts - activeContactIds.length) / totalContacts) * 100 : 0

  const revenueDeltaPct = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : (revenue > 0 ? 100 : 0)
  const conversionDeltaPp = Math.round(conversion - prevConversion)
  const churnDeltaPp = Math.round(churn - prevChurn)
  const cycleDeltaDays = (cycleDays != null && prevCycleDays != null) ? cycleDays - prevCycleDays : null

  // Receita dos últimos 6 meses
  const monthlyRevenue = []
  for (let i = 5; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
    const rows = await prisma.deal.findMany({ where: { tenantId, closedAt: { gte: start, lte: end } }, select: { value: true } })
    monthlyRevenue.push({ month: start.toLocaleString('pt-BR', { month: 'short' }), value: rows.reduce((s, r) => s + Number(r.value), 0) })
  }

  // Funil por estágio
  const maxCount = Math.max(...stages.map(s => s.deals.length), 1)
  const funnel = stages.map(s => ({
    name: s.name, color: s.color,
    count: s.deals.length,
    pct: Math.round((s.deals.length / maxCount) * 100),
    value: s.deals.reduce((sum, d) => sum + Number(d.value), 0),
  }))

  // Origem dos leads (no período)
  const originMap = {}
  contacts.forEach(c => { originMap[c.origin || 'outro'] = (originMap[c.origin || 'outro'] || 0) + 1 })
  const total = contacts.length || 1
  const origins = Object.entries(originMap).map(([name, count]) => ({ name, count, pct: Math.round(count / total * 100) })).sort((a, b) => b.count - a.count)

  // ── INSIGHTS (análises reais em cima do banco, nada fixo) ─────────────────

  // 1) Oportunidade: negócios abertos parados há mais de N dias numa etapa
  const stuckByStage = {}
  stuckDeals.forEach(d => {
    stuckByStage[d.stageId] = stuckByStage[d.stageId] || { count: 0, value: 0 }
    stuckByStage[d.stageId].count++
    stuckByStage[d.stageId].value += Number(d.value)
  })
  const stuckTop = Object.entries(stuckByStage).sort((a, b) => b[1].count - a[1].count)[0]
  let opportunityInsight
  if (stuckTop) {
    const [stageId, agg] = stuckTop
    const stage = stages.find(s => s.id === stageId)
    opportunityInsight = {
      icon: '🤖', title: 'IA · Oportunidade',
      text: `${agg.count} lead${agg.count > 1 ? 's' : ''} ${agg.count > 1 ? 'estão parados' : 'está parado'} há mais de ${stuckDays} dias na etapa "${stage?.name ?? '—'}". Um follow-up agora pode recuperar ${fmtBRL(agg.value)} em negócios.`,
      actionLabel: 'Ver leads →', actionUrl: `crm-pipeline.html?stageId=${stageId}`,
    }
  } else {
    opportunityInsight = {
      icon: '✅', title: 'IA · Oportunidade',
      text: `Nenhum negócio parado há mais de ${stuckDays} dias sem atualização. Sua carteira está em dia.`,
      actionLabel: null, actionUrl: null,
    }
  }
  opportunityInsight.control = { type: 'stuckDays', value: stuckDays, options: [3, 7, 14, 30] }

  // 2) Conversão: maior queda de taxa entre um par de etapas (A → B, não precisa ser adjacente
  //    na ordem do funil — um negócio pode pular etapas, ex: Proposta → Fechado direto) vs período anterior
  const stageNames = stages.map(s => s.name)
  const curTrans  = transitionStats(curStageChanges, stageNames)
  const prevTrans = transitionStats(prevStageChanges, stageNames)
  const pairsSeen = new Set()
  stageNames.forEach(a => {
    Object.keys(curTrans[a].next).forEach(b => pairsSeen.add(a + '|' + b))
    Object.keys(prevTrans[a].next).forEach(b => pairsSeen.add(a + '|' + b))
  })
  let worstDrop = null
  pairsSeen.forEach(pair => {
    const [a, b] = pair.split('|')
    const curOut = curTrans[a].out, curNext = curTrans[a].next[b] || 0
    const prevOut = prevTrans[a].out, prevNext = prevTrans[a].next[b] || 0
    if (curOut < 1 || prevOut < 1) return
    const curPct = (curNext / curOut) * 100, prevPct = (prevNext / prevOut) * 100
    const drop = prevPct - curPct
    if (drop > 0 && (!worstDrop || drop > worstDrop.drop)) worstDrop = { a, b, curPct, prevPct, drop }
  })
  let conversionInsight
  if (worstDrop) {
    conversionInsight = {
      icon: '⚠️', title: 'Atenção · Conversão',
      text: `A conversão de "${worstDrop.a} → ${worstDrop.b}" caiu de ${Math.round(worstDrop.prevPct)}% para ${Math.round(worstDrop.curPct)}% neste período. Revise sua abordagem nessa etapa.`,
      actionLabel: 'Ver funil →', actionUrl: '#funnelCard',
    }
  } else {
    conversionInsight = {
      icon: 'ℹ️', title: 'Conversão · Etapas',
      text: `Ainda não há histórico suficiente de mudanças de etapa neste e no período anterior para comparar a conversão.`,
      actionLabel: null, actionUrl: null,
    }
  }

  // 3) Canal: origem com mais leads e sua taxa de conversão real
  const originStats = {}
  allContacts.forEach(c => {
    const key = c.origin || 'outro'
    originStats[key] = originStats[key] || { total: 0, won: 0 }
    originStats[key].total++
    if (c.deals.some(d => d.closedAt)) originStats[key].won++
  })
  const originEntries = Object.entries(originStats).map(([name, s]) => ({
    name, count: s.total, conv: s.total > 0 ? (s.won / s.total) * 100 : 0,
  }))
  const totalContactsAll = allContacts.length || 1
  const bestByCount = originEntries.slice().sort((a, b) => b.count - a.count)[0]
  let channelInsight
  if (bestByCount && bestByCount.count > 0) {
    const avgConv = originEntries.reduce((s, o) => s + o.conv, 0) / originEntries.length
    const pct = Math.round((bestByCount.count / totalContactsAll) * 100)
    const label = ORIGIN_LABELS[bestByCount.name] || bestByCount.name
    if (bestByCount.conv >= avgConv) {
      channelInsight = {
        icon: '🏆', title: 'Destaque · Canal',
        text: `${label} representa ${pct}% dos leads e tem a maior taxa de conversão (${Math.round(bestByCount.conv)}%). Priorize esse canal.`,
        actionLabel: 'Ver origens →', actionUrl: '#origemCard',
      }
    } else {
      channelInsight = {
        icon: '⚠️', title: 'Atenção · Canal',
        text: `${label} representa ${pct}% dos leads, mas converte só ${Math.round(bestByCount.conv)}%, abaixo da média dos canais (${Math.round(avgConv)}%). Avalie a qualidade desses leads.`,
        actionLabel: 'Ver origens →', actionUrl: '#origemCard',
      }
    }
  } else {
    channelInsight = {
      icon: 'ℹ️', title: 'Canal · Origem',
      text: `Ainda não há leads suficientes com origem registrada para essa análise.`,
      actionLabel: null, actionUrl: null,
    }
  }

  const insights = [opportunityInsight, conversionInsight, channelInsight]

  res.json({
    revenue, revenueDeltaPct,
    conversion: Number(conversion.toFixed(1)), conversionDeltaPp,
    churn: Number(churn.toFixed(1)), churnDeltaPp,
    cycleDays, cycleDeltaDays,
    totalDeals: totalCreated, monthlyRevenue, funnel, origins, topDeals, insights,
  })
})

export default router

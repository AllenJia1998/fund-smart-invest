/**
 * 数据源注册与选择。
 *
 * 目标源（蚂蚁财富）不可达时自动降级到等价源（天天基金），并把降级事实
 * 暴露给前端，而不是静默伪装。
 */
import { config } from '../config.js';
import { antfortune, probe as probeAntfortune } from './antfortune.js';
import { eastmoney } from './eastmoney.js';

const REGISTRY = { antfortune, eastmoney };

let resolved;

/** 选择可用 Provider：配置指定的源优先，不可用则降级。 */
export async function getProvider() {
  if (resolved) return resolved;

  const preferred = REGISTRY[config.fundProvider];
  if (config.fundProvider === 'antfortune') {
    const health = await probeAntfortune();
    if (health.ok) {
      resolved = { provider: antfortune, requested: 'antfortune', degraded: false, reason: null };
      return resolved;
    }
    resolved = {
      provider: eastmoney,
      requested: 'antfortune',
      degraded: true,
      reason: `蚂蚁财富接口不可达（${health.reason || 'unknown'}），已自动降级到天天基金`,
    };
    return resolved;
  }

  resolved = {
    provider: preferred ?? eastmoney,
    requested: config.fundProvider,
    degraded: false,
    reason: null,
  };
  return resolved;
}

/** 数据源状态，供 /api/funds/source 与前端展示。 */
export async function sourceStatus() {
  const { provider, requested, degraded, reason } = await getProvider();
  const health = await probeAntfortune();
  return {
    active: provider.id,
    activeLabel: provider.label,
    requested,
    degraded,
    reason,
    candidates: [
      {
        id: antfortune.id,
        label: antfortune.label,
        reachable: health.ok,
        note: health.ok ? '接口可达' : `不可达：${health.reason}`,
      },
      {
        id: eastmoney.id,
        label: eastmoney.label,
        reachable: true,
        note: '接口可达，与蚂蚁财富同为天天基金数据口径',
      },
    ],
    checkedAt: new Date().toISOString(),
  };
}

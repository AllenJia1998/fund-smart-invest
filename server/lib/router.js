/** 极简路由器：支持 `:param` 占位符与异步处理器。 */
export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const segments = pattern.split('/').filter(Boolean);
    routes.push({ method, segments, handler });
  };

  function match(segments, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== segments.length) return null;
    const params = {};
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) return null;
    }
    return params;
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    /** 返回 true 表示已处理。 */
    async handle({ method, pathname, params: ctxParams = {} }) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const params = match(route.segments, pathname);
        if (!params) continue;
        return { handler: route.handler, params: { ...ctxParams, ...params } };
      }
      return null;
    },
    list: () => routes.map((r) => `${r.method} /${r.segments.join('/')}`),
  };
}

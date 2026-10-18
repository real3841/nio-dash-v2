/** 高德 JS API 2.0 动态加载器 */

declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

let cached: Promise<any> | null = null;

export function loadAmap(key: string, securityCode?: string): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (cached) return cached;

  cached = new Promise<any>((resolve, reject) => {
    if (securityCode) {
      window._AMapSecurityConfig = { securityJsCode: securityCode };
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;

    const timer = window.setTimeout(() => {
      reject(new Error("高德地图加载超时"));
    }, 12000);

    script.onload = () => {
      window.clearTimeout(timer);
      if (window.AMap) resolve(window.AMap);
      else reject(new Error("高德地图未初始化（key 可能无效）"));
    };

    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("高德地图脚本加载失败"));
    };

    document.head.appendChild(script);
  }).catch((error) => {
    cached = null;
    throw error;
  });

  return cached;
}

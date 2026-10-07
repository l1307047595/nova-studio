import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'

// 全量跑时 environment 阶段可达 100~240s，Testing Library 默认 1s 的异步超时会让
// findBy*/waitFor 偶发超时（同一用例单独跑必过、全量跑随机挂）。放宽到 5s，消除这类伪失败。
configure({ asyncUtilTimeout: 5000 })

// Node ≥25 在 globalThis 上放置了实验性的 localStorage/sessionStorage 占位（值为 undefined），
// vitest 的 getWindowKeys 因此跳过代理，jsdom 的真实实现到不了测试代码；
// 模块顶层读 localStorage 的代码（如 gemini-config 的动态模型导出）会在导入期崩溃。
for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (typeof globalThis[name] === 'undefined') {
    const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window
    const storage = jsdomWindow?.[name]
    if (storage) {
      Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true })
    }
  }
}

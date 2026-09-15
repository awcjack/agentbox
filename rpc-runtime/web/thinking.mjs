const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function thinkingLevels(levels) {
  const available = new Set(Array.isArray(levels) ? levels : []);
  return order.filter((level) => available.has(level));
}

// Include native identity so replacement/resumed conversations never reuse a
// discovery response belonging to another conversation or model.
export function thinkingModelKey(meta, state) {
  const model = state?.model;
  return meta?.nativeSessionId && model?.provider && model?.id
    ? JSON.stringify([meta.nativeSessionId, model.provider, model.id]) : null;
}

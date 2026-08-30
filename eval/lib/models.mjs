export function normalizeEvalModel(model, label = "model", defaultProvider = "opencode-go") {
  const value = String(model || "").trim();
  if (!value) {
    return "";
  }

  if (/\s/u.test(value)) {
    throw new Error(`${label} ${value} must be a model id without whitespace`);
  }

  if (!value.includes("/")) {
    return defaultProvider ? `${defaultProvider}/${value}` : value;
  }

  return value;
}

export function normalizeEvalModels(models, defaultProvider = "opencode-go") {
  return models.map((model, index) => normalizeEvalModel(model, `model[${index}]`, defaultProvider));
}

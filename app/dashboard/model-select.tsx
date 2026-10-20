// The operator's priced models (INFERENCE_PRICES); pricier models use the workspace's monthly usage faster.
// Deployments without a list keep a free-text field. A saved model that is no longer offered shows as the default.
export function ModelSelect({ name, value, models, empty }: { name: string; value?: string; models: { model: string; input: number; output: number }[]; empty: string }) {
  if (!models.length) return <input name={name} maxLength={200} defaultValue={value ?? ""} placeholder={empty} />;
  return <select name={name} defaultValue={models.some((m) => m.model === value) ? value : ""}>
    <option value="">{empty}</option>
    {models.map((m) => <option key={m.model} value={m.model}>{m.model} · ${m.input} in / ${m.output} out per 1M tokens</option>)}
  </select>;
}

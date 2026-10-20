// The operator's priced models (INFERENCE_PRICES); pricier models use the workspace's monthly usage faster.
// Deployments without a list keep a free-text field. A saved model that is no longer offered shows as the default.
// key: React ignores a new defaultValue on a mounted <select> and resets the form after the save action,
// so without a remount the select snaps back to the value it first rendered with.
export function ModelSelect({ name, value, models, empty }: { name: string; value?: string; models: { model: string; input: number; output: number }[]; empty: string }) {
  if (!models.length) return <input name={name} maxLength={200} defaultValue={value ?? ""} placeholder={empty} />;
  const selected = models.some((m) => m.model === value) ? value : "";
  return <select key={selected} name={name} defaultValue={selected}>
    <option value="">{empty}</option>
    {models.map((m) => <option key={m.model} value={m.model}>{m.model} · ${m.input} in / ${m.output} out per 1M tokens</option>)}
  </select>;
}

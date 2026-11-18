import React, { useState } from 'react';
import { getIngestionPresets, saveIngestionPresets, IngestionSettings } from '../services/ingestionPresets';

export function IngestionPresets({ settings, onApply, disabled }: { settings: IngestionSettings; onApply: (settings: IngestionSettings) => void; disabled: boolean }) {
  const [presets, setPresets] = useState(getIngestionPresets);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const persist = (next: typeof presets) => {
    try { saveIngestionPresets(next); setPresets(next); setError(''); return true; }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save presets.'); return false; }
  };
  return <fieldset disabled={disabled} className="space-y-2 border-t border-[#30363d] pt-3 disabled:opacity-50">
    <legend className="text-xs font-bold text-gray-300">Ingestion presets</legend>
    <div className="flex flex-wrap gap-2 text-xs">
      <select aria-label="Saved ingestion preset" className="rounded border border-[#30363d] bg-[#0d1117] p-2 text-white" value={selected} onChange={event => {
        const value = event.target.value; setSelected(value);
        const preset = presets.find(p => p.name === value);
        if (preset) { onApply(preset); setName(preset.name); }
      }}>
        <option value="">Choose preset…</option>
        {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>
      <input aria-label="Preset name" maxLength={80} placeholder="Preset name" value={name} onChange={event => setName(event.target.value)} className="min-w-0 rounded border border-[#30363d] bg-[#0d1117] p-2 text-white" />
      <button type="button" className="text-amber-300 cursor-pointer" disabled={!name.trim()} onClick={() => {
        const clean = name.trim();
        if (persist([...presets.filter(p => p.name.toLowerCase() !== clean.toLowerCase()), { ...settings, name: clean }])) setSelected(clean);
      }}>{presets.some(p => p.name.toLowerCase() === name.trim().toLowerCase()) ? 'Update preset' : 'Save preset'}</button>
      <button type="button" className="text-gray-300 cursor-pointer" disabled={!selected} onClick={() => {
        if (persist(presets.filter(p => p.name !== selected))) { setSelected(''); setName(''); }
      }}>Delete preset</button>
    </div>
    <p className="text-[11px] text-gray-400">Saves filters, size limits, output format and decompilation setting.</p>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </fieldset>;
}

import React, { useState } from 'react';
import { Bookmark, ChevronDown } from 'lucide-react';
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
  const controlClass = 'rounded-lg border-2 border-[#30363d] bg-[#0d1117] px-3 py-2 text-gray-200 focus-visible:border-amber-500';
  const buttonClass = 'rounded-lg border-2 border-[#30363d] bg-[#21262d] px-3 py-2 font-bold shadow-[2px_2px_0_0_#000000] transition-colors enabled:cursor-pointer enabled:hover:bg-[#30363d] disabled:opacity-50';
  return <details className="group border-t-2 border-[#30363d]/70 pt-2">
    <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 py-1 text-xs font-extrabold text-gray-300 hover:text-amber-400 [&::-webkit-details-marker]:hidden">
      <Bookmark aria-hidden="true" className="h-3.5 w-3.5 text-amber-400" />
      Ingestion presets
      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-gray-400 transition-transform group-open:rotate-180" />
    </summary>
    <fieldset aria-label="Manage ingestion presets" disabled={disabled} className="mt-2 space-y-2 rounded-xl border-2 border-[#30363d] bg-[#161b22] p-3 disabled:opacity-50">
    <div className="flex flex-wrap gap-2 text-xs">
      <select aria-label="Saved ingestion preset" className={`${controlClass} max-w-full min-w-0`} value={selected} onChange={event => {
        const value = event.target.value; setSelected(value);
        const preset = presets.find(p => p.name === value);
        if (preset) { onApply(preset); setName(preset.name); }
      }}>
        <option value="">Choose preset…</option>
        {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>
      <input aria-label="Preset name" maxLength={80} placeholder="Preset name" value={name} onChange={event => setName(event.target.value)} className={`${controlClass} min-w-0`} />
      <button type="button" className={`${buttonClass} text-amber-300`} disabled={!name.trim()} onClick={() => {
        const clean = name.trim();
        if (persist([...presets.filter(p => p.name.toLowerCase() !== clean.toLowerCase()), { ...settings, name: clean }])) setSelected(clean);
      }}>{presets.some(p => p.name.toLowerCase() === name.trim().toLowerCase()) ? 'Update preset' : 'Save preset'}</button>
      <button type="button" className={`${buttonClass} text-gray-300 enabled:hover:text-red-300`} disabled={!selected} onClick={() => {
        if (persist(presets.filter(p => p.name !== selected))) { setSelected(''); setName(''); }
      }}>Delete preset</button>
    </div>
    <p className="text-[11px] text-gray-400">Saves filters, size limits, output format and decompilation setting.</p>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </fieldset>
  </details>;
}

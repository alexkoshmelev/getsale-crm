'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Pencil, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  fetchPipelines,
  fetchStages,
  createPipeline,
  updatePipeline,
  deletePipeline,
  createStage,
  updateStage,
  deleteStage,
  type Pipeline,
  type Stage,
} from '@/lib/api/pipeline';

interface PipelineManageModalProps {
  open: boolean;
  onClose: () => void;
  selectedPipelineId: string | null;
  onPipelinesChange: () => void;
  onStagesChange: () => void;
}

export function PipelineManageModal({
  open,
  onClose,
  selectedPipelineId,
  onPipelinesChange,
  onStagesChange,
}: PipelineManageModalProps) {
  const { t } = useTranslation();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingPipelineId, setEditingPipelineId] = useState<string | null>(null);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [newStageName, setNewStageName] = useState('');
  const [addPipelineMode, setAddPipelineMode] = useState(false);
  const [addStageMode, setAddStageMode] = useState(false);
  const [editPipelineName, setEditPipelineName] = useState('');
  const [editStageName, setEditStageName] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchPipelines()
      .then(setPipelines)
      .catch(() => setPipelines([]))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open || !selectedPipelineId) {
      setStages([]);
      return;
    }
    fetchStages(selectedPipelineId).then(setStages).catch(() => setStages([]));
  }, [open, selectedPipelineId]);

  const handleCreatePipeline = async () => {
    const name = newPipelineName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await createPipeline({ name });
      setNewPipelineName('');
      setAddPipelineMode(false);
      const list = await fetchPipelines();
      setPipelines(list);
      onPipelinesChange();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdatePipeline = async (id: string) => {
    const name = editPipelineName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await updatePipeline(id, { name });
      setEditingPipelineId(null);
      const list = await fetchPipelines();
      setPipelines(list);
      onPipelinesChange();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePipeline = async (p: Pipeline) => {
    if (!window.confirm(t('pipeline.deletePipelineConfirm', { name: p.name }))) return;
    setSaving(true);
    try {
      await deletePipeline(p.id);
      const list = await fetchPipelines();
      setPipelines(list);
      onPipelinesChange();
      onStagesChange();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateStage = async () => {
    const name = newStageName.trim();
    if (!name || !selectedPipelineId) return;
    setSaving(true);
    try {
      const maxOrder = stages.length ? Math.max(...stages.map((s) => s.order_index)) + 1 : 0;
      await createStage({ pipelineId: selectedPipelineId, name, orderIndex: maxOrder });
      setNewStageName('');
      setAddStageMode(false);
      const list = await fetchStages(selectedPipelineId);
      setStages(list.sort((a, b) => a.order_index - b.order_index));
      onStagesChange();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateStage = async (id: string) => {
    const name = editStageName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await updateStage(id, { name });
      setEditingStageId(null);
      if (selectedPipelineId) {
        const list = await fetchStages(selectedPipelineId);
        setStages(list.sort((a, b) => a.order_index - b.order_index));
      }
      onStagesChange();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStage = async (s: Stage) => {
    if (!window.confirm(t('pipeline.deleteStageConfirm', { name: s.name }))) return;
    setSaving(true);
    try {
      await deleteStage(s.id);
      if (selectedPipelineId) {
        const list = await fetchStages(selectedPipelineId);
        setStages(list.sort((a, b) => a.order_index - b.order_index));
      }
      onStagesChange();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50" aria-hidden onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-card border border-border rounded-2xl shadow-xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h2 className="font-heading text-lg font-semibold text-foreground">{t('pipeline.managePipelines')}</h2>
          <button type="button" onClick={onClose} className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-foreground">{t('pipeline.selectPipeline')}</h3>
              {!addPipelineMode ? (
                <Button variant="outline" size="sm" onClick={() => setAddPipelineMode(true)}>
                  <Plus className="w-4 h-4 mr-1" />
                  {t('pipeline.addPipeline')}
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Input
                    placeholder={t('pipeline.pipelineName')}
                    value={newPipelineName}
                    onChange={(e) => setNewPipelineName(e.target.value)}
                    className="w-40 h-8 text-sm"
                  />
                  <Button size="sm" onClick={handleCreatePipeline} disabled={saving || !newPipelineName.trim()}>
                    {t('common.save')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setAddPipelineMode(false); setNewPipelineName(''); }}>
                    {t('common.cancel')}
                  </Button>
                </div>
              )}
            </div>
            {loading ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : (
              <ul className="space-y-1">
                {pipelines.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 py-1.5">
                    {editingPipelineId === p.id ? (
                      <>
                        <Input
                          value={editPipelineName}
                          onChange={(e) => setEditPipelineName(e.target.value)}
                          className="flex-1 h-8 text-sm"
                        />
                        <Button size="sm" onClick={() => handleUpdatePipeline(p.id)} disabled={saving}>Save</Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingPipelineId(null)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 truncate text-sm font-medium">{p.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPipelineId(p.id);
                            setEditPipelineName(p.name);
                          }}
                          className="p-1.5 rounded text-muted-foreground hover:bg-accent"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePipeline(p)}
                          disabled={saving}
                          className="p-1.5 rounded text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selectedPipelineId && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-foreground">{t('pipeline.stagesForPipeline', { name: pipelines.find((x) => x.id === selectedPipelineId)?.name ?? '' })}</h3>
                {!addStageMode ? (
                  <Button variant="outline" size="sm" onClick={() => setAddStageMode(true)}>
                    <Plus className="w-4 h-4 mr-1" />
                    {t('pipeline.addStage')}
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      placeholder={t('pipeline.stageName')}
                      value={newStageName}
                      onChange={(e) => setNewStageName(e.target.value)}
                      className="w-40 h-8 text-sm"
                    />
                    <Button size="sm" onClick={handleCreateStage} disabled={saving || !newStageName.trim()}>
                      {t('common.save')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setAddStageMode(false); setNewStageName(''); }}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                )}
              </div>
              <ul className="space-y-1">
                {stages.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-1.5">
                    {editingStageId === s.id ? (
                      <>
                        <Input
                          value={editStageName}
                          onChange={(e) => setEditStageName(e.target.value)}
                          className="flex-1 h-8 text-sm"
                        />
                        <Button size="sm" onClick={() => handleUpdateStage(s.id)} disabled={saving}>Save</Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingStageId(null)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 truncate text-sm">{s.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingStageId(s.id);
                            setEditStageName(s.name);
                          }}
                          className="p-1.5 rounded text-muted-foreground hover:bg-accent"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteStage(s)}
                          disabled={saving}
                          className="p-1.5 rounded text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

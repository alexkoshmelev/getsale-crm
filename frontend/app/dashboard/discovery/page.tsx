'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2, Play, Pause, Square, Plus, Search, Sparkles, CheckSquare, Settings
} from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { reportWarning } from '@/lib/error-reporter';
import {
  fetchDiscoveryTasks,
  fetchDiscoveryTask,
  createDiscoveryTask,
  updateDiscoveryTaskAction,
  generateSearchQueries,
  parseResolve,
  parseStart,
  fetchParseResult,
  type DiscoveryTask,
  type SearchGroupItem,
  type SearchType,
  type ResolvedSource,
} from '@/lib/api/discovery';
import ParseSourceInput from '@/components/parsing/ParseSourceInput';
import SourceTypeCard from '@/components/parsing/SourceTypeCard';
import ParseSettingsForm from '@/components/parsing/ParseSettingsForm';
import ParseProgressPanel from '@/components/parsing/ParseProgressPanel';
import ParseResultSummary from '@/components/parsing/ParseResultSummary';
import type { ParseResult } from '@/lib/api/discovery';
import { Button } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { ru } from 'date-fns/locale';

interface BdAccount {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  phone_number?: string | null;
  is_active?: boolean;
}

function getAccountDisplayName(account: BdAccount): string {
  if (account.display_name?.trim()) return account.display_name.trim();
  const first = (account.first_name ?? '').trim();
  const last = (account.last_name ?? '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  if (account.username?.trim()) return account.username.trim();
  if (account.phone_number?.trim()) return account.phone_number.trim();
  return '—';
}

interface Campaign {
  id: string;
  name: string;
}

type TabType = 'tasks' | 'new_search' | 'new_parse';

const TASKS_PAGE_SIZE = 10;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function ContactDiscoveryPage() {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabType>('tasks');
  const [accounts, setAccounts] = useState<BdAccount[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Tasks state
  const [tasks, setTasks] = useState<DiscoveryTask[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [selectedTask, setSelectedTask] = useState<DiscoveryTask | null>(null);
  const [selectedChatsForParse, setSelectedChatsForParse] = useState<(SearchGroupItem & { disabled?: boolean })[]>([]);

  // Search task form state
  const [searchName, setSearchName] = useState('');
  const [searchAccountId, setSearchAccountId] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('all');
  const [queriesText, setQueriesText] = useState('');
  const [aiTopic, setAiTopic] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  // Parse task form state
  const [parseName, setParseName] = useState('');
  const [parseAccountId, setParseAccountId] = useState('');
  const [parseLinksText, setParseLinksText] = useState('');
  const [parseMode, setParseMode] = useState<'all' | 'active'>('all');
  const [postDepth, setPostDepth] = useState<number | ''>(100);
  const [excludeAdmins, setExcludeAdmins] = useState(false);
  const [leaveAfter, setLeaveAfter] = useState(false);
  const [exportCampaignId, setExportCampaignId] = useState('');
  const [newCampaignName, setNewCampaignName] = useState('');

  // New parse flow (smart resolve + strategy)
  const [parseStep, setParseStep] = useState<1 | 2 | 3 | 4>(1);
  const [parseResolveAccountId, setParseResolveAccountId] = useState('');
  const [resolvedSources, setResolvedSources] = useState<ResolvedSource[]>([]);
  const [parseDepth, setParseDepth] = useState<'fast' | 'standard' | 'deep'>('standard');
  const [parseExcludeAdmins, setParseExcludeAdmins] = useState(true);
  const [parseListName, setParseListName] = useState('');
  const [parseAccountIds, setParseAccountIds] = useState<string[]>([]);
  const [parseTaskId, setParseTaskId] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [parseStarting, setParseStarting] = useState(false);
  const [parseCreateCampaign, setParseCreateCampaign] = useState(true);

  useEffect(() => {
    if (accounts.length > 0 && !parseResolveAccountId) setParseResolveAccountId(accounts[0].id);
  }, [accounts, parseResolveAccountId]);
  
  const loadAccounts = useCallback(() => {
    apiClient.get<BdAccount[]>('/api/bd-accounts').then((r) => {
      const list = Array.isArray(r.data) ? r.data.filter((a) => a.is_active !== false) : [];
      setAccounts(list);
      if (list.length > 0) {
        setSearchAccountId(list[0].id);
        setParseAccountId(list[0].id);
        setParseResolveAccountId((prev) => prev || list[0].id);
      }
    }).catch(() => setAccounts([]));
  }, []);

  const loadCampaigns = useCallback(() => {
    apiClient.get<Campaign[]>('/api/campaigns').then((r) => {
      setCampaigns(r.data || []);
    }).catch(() => setCampaigns([]));
  }, []);

  const loadTasks = useCallback((pageOverride?: number) => {
    setLoadingTasks(true);
    const page = pageOverride ?? taskPage;
    const offset = (page - 1) * TASKS_PAGE_SIZE;
    fetchDiscoveryTasks(TASKS_PAGE_SIZE, offset)
      .then((r) => {
        setTasks(r.tasks);
        setTaskTotal(r.total);
      })
      .catch((e) => setError(e?.response?.data?.error ?? e?.message ?? t('discovery.errors.loadFailed')))
      .finally(() => setLoadingTasks(false));
  }, [taskPage]);

  useEffect(() => {
    loadAccounts();
    loadCampaigns();
  }, [loadAccounts, loadCampaigns]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Polling for tasks
  useEffect(() => {
    const interval = setInterval(() => {
      if (activeTab === 'tasks') {
        const offset = (taskPage - 1) * TASKS_PAGE_SIZE;
        fetchDiscoveryTasks(TASKS_PAGE_SIZE, offset)
          .then((r) => {
            setTasks(r.tasks);
            setTaskTotal(r.total);
          })
          .catch((err) => {
            reportWarning('Discovery tasks poll failed', { component: 'DiscoveryPage', error: err });
          });
      }
      if (selectedTask) {
        fetchDiscoveryTask(selectedTask.id).then((r) => setSelectedTask(r)).catch((err) => {
          reportWarning('Discovery task refresh failed', { component: 'DiscoveryPage', error: err });
        });
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [activeTab, selectedTask, taskPage]);

  const handleGenerateQueries = () => {
    const topic = aiTopic.trim();
    if (!topic) return;
    setError(null);
    setAiLoading(true);
    generateSearchQueries(topic)
      .then((r) => {
         const newQ = (r.queries || []).join('\n');
         setQueriesText((prev) => prev ? prev + '\n' + newQ : newQ);
      })
      .catch((e) => setError(e?.response?.data?.error ?? e?.message ?? t('discovery.errors.aiFailed')))
      .finally(() => setAiLoading(false));
  };

  const handleCreateSearchTask = () => {
    const lines = queriesText.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (!searchName.trim()) return setError(t('discovery.errors.enterTaskName'));
    if (!searchAccountId) return setError(t('discovery.errors.selectBdAccount'));
    if (lines.length === 0) return setError(t('discovery.errors.enterQueries'));
    
    setError(null);
    createDiscoveryTask({
      name: searchName.trim(),
      type: 'search',
      params: {
        bdAccountId: searchAccountId,
        searchType,
        queries: lines,
        limitPerQuery: 50
      }
    }).then(() => {
      setSearchName('');
      setQueriesText('');
      setAiTopic('');
      setActiveTab('tasks');
      setTaskPage(1);
      loadTasks(1);
    }).catch(e => setError(e?.message || t('discovery.errors.createFailed')));
  };

  const handleCreateParseTask = () => {
    if (!parseName.trim()) return setError(t('discovery.errors.enterTaskName'));
    if (!parseAccountId) return setError(t('discovery.errors.selectBdAccount'));
    
    let targetChats: { chatId: string, title?: string, peerType?: string }[] = [];
    if (selectedChatsForParse.length > 0) {
      targetChats = selectedChatsForParse.filter(c => !c.disabled).map(c => ({ chatId: c.chatId, title: c.title, peerType: c.peerType }));
      if (targetChats.length === 0) return setError(t('discovery.errors.selectOneGroup'));
    } else {
      const lines = parseLinksText.split(/\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) return setError(t('discovery.errors.enterLinksOrSelect'));
      targetChats = lines.map(l => ({ chatId: l }));
    }

    if (parseMode === 'active' && (!postDepth || postDepth < 1 || postDepth > 2000)) {
       return setError(t('discovery.errors.postDepthRange'));
    }

    setError(null);
    createDiscoveryTask({
      name: parseName.trim(),
      type: 'parse',
      params: {
        bdAccountId: parseAccountId,
        chats: targetChats,
        parseMode,
        postDepth: parseMode === 'active' ? postDepth : undefined,
        excludeAdmins,
        leaveAfter,
        campaignId: exportCampaignId || undefined,
        campaignName: !exportCampaignId && newCampaignName.trim() ? newCampaignName.trim() : undefined,
      }
    }).then(() => {
      setParseName('');
      setParseLinksText('');
      setSelectedChatsForParse([]);
      setNewCampaignName('');
      setExportCampaignId('');
      setActiveTab('tasks');
      setTaskPage(1);
      loadTasks(1);
    }).catch(e => setError(e?.message || t('discovery.errors.createFailed')));
  };

  const handleTaskAction = (id: string, action: 'start'|'pause'|'stop') => {
     updateDiscoveryTaskAction(id, action).then(() => {
        loadTasks();
        if (selectedTask?.id === id) {
           fetchDiscoveryTask(id).then(r => setSelectedTask(r));
        }
     }).catch(e => setError(e?.response?.data?.message || t('discovery.errors.actionFailed')));
  };

  const openParseFromSearch = (task: DiscoveryTask) => {
     if (task.type !== 'search') return;
     const groups = task.results?.groups || [];
     if (groups.length === 0) return setError(t('discovery.errors.noGroupsInTask'));
     const bdAccountId = task.params?.bdAccountId ?? task.params?.accountId;
     if (!bdAccountId) return setError(t('discovery.errors.noBdAccountInTask'));
     setSelectedChatsForParse(groups);
     setParseAccountId(bdAccountId);
     setParseName(`Parse from: ${task.name}`);
     setResolvedSources(
       groups.map((g: any) => ({
         input: g.chatId,
         chatId: String(g.chatId ?? ''),
         title: g.title != null ? String(g.title) : String(g.chatId ?? ''),
         type: (g.peerType === 'channel' ? 'channel' : 'public_group') as ResolvedSource['type'],
         canGetMembers: true,
         canGetMessages: true,
       }))
     );
     setParseResolveAccountId(bdAccountId);
     setParseAccountIds([bdAccountId]);
     setParseStep(2);
     setActiveTab('new_parse');
     setSelectedTask(null);
  };

  const handleParseResolve = async (sources: string[], bdAccountId: string) => {
    const { results } = await parseResolve(bdAccountId, sources);
    setResolvedSources(results);
    setParseStep(2);
    setParseAccountIds((prev) => (prev.length > 0 ? prev : [bdAccountId]));
  };

  const handleParseStart = async () => {
    const valid = resolvedSources.filter((s) => !s.error && s.chatId);
    const accountIds = parseAccountIds.filter((id): id is string => typeof id === 'string' && UUID_REGEX.test(id));
    if (valid.length === 0 || accountIds.length === 0) {
      if (parseAccountIds.length > 0 && accountIds.length === 0) setError(t('discovery.errors.selectBdAccount'));
      return;
    }
    setParseStarting(true);
    setError(null);
    try {
      const { taskId } = await parseStart({
        sources: valid.map((s) => ({
          input: String(s.input ?? s.chatId ?? ''),
          type: s.type,
          title: String(s.title ?? ''),
          username: s.username != null ? String(s.username) : undefined,
          chatId: String(s.chatId),
          membersCount: s.membersCount,
          linkedChatId: s.linkedChatId,
          canGetMembers: Boolean(s.canGetMembers),
          canGetMessages: Boolean(s.canGetMessages),
        })),
        settings: { depth: parseDepth, excludeAdmins: parseExcludeAdmins },
        accountIds,
        listName: parseListName.trim() || undefined,
        ...(parseCreateCampaign && parseListName.trim() ? { campaignName: parseListName.trim() } : {}),
      });
      setParseTaskId(taskId);
      setParseStep(3);
      loadTasks();
    } catch (e: any) {
      const data = e?.response?.data;
      const details = Array.isArray(data?.details) ? data.details : [];
      const firstDetail = details[0];
      const detailMsg = firstDetail?.message ? `${firstDetail.path ? `${firstDetail.path}: ` : ''}${firstDetail.message}` : null;
      setError(detailMsg ?? data?.error ?? e?.message ?? t('discovery.errors.parseStartError'));
    } finally {
      setParseStarting(false);
    }
  };

  const handleParseProgressStopped = async () => {
    if (parseTaskId) {
      try {
        const result = await fetchParseResult(parseTaskId);
        setParseResult(result);
        setParseStep(4);
      } catch (e) {
        reportWarning('[discovery] fetchParseResult failed', { component: 'DiscoveryPage', error: e });
      }
    }
  };

  const handleParseRunAgain = () => {
    setParseStep(1);
    setResolvedSources([]);
    setParseTaskId(null);
    setParseResult(null);
  };

  const renderProgressBar = (progress: number, total: number) => {
     const p = total > 0 ? Math.round((progress / total) * 100) : 0;
     return (
       <div className="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
         <div className="bg-blue-600 h-2.5 rounded-full" style={{ width: `${p}%` }}></div>
       </div>
     );
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('discovery.title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('discovery.subtitle')}
          </p>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-md border border-red-200">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex space-x-1 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => { setActiveTab('tasks'); setSelectedTask(null); }}
          className={clsx(
            "px-4 py-2 text-sm font-medium border-b-2",
            activeTab === 'tasks' && !selectedTask ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
          )}
        >
          {t('discovery.tabs.tasks')}
        </button>
        <button
          onClick={() => { setActiveTab('new_search'); setSelectedTask(null); }}
          className={clsx(
            "px-4 py-2 text-sm font-medium border-b-2",
            activeTab === 'new_search' ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
          )}
        >
          <Plus className="w-4 h-4 inline-block mr-1" />
          {t('discovery.tabs.newSearch')}
        </button>
        <button
          onClick={() => { setActiveTab('new_parse'); setSelectedTask(null); }}
          className={clsx(
            "px-4 py-2 text-sm font-medium border-b-2",
            activeTab === 'new_parse' ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
          )}
        >
          <Plus className="w-4 h-4 inline-block mr-1" />
          {t('discovery.tabs.newParse')}
        </button>
      </div>

      {/* Content */}
      <div className="mt-4">
        {selectedTask ? (
           // Task Details
           <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-6">
             <div className="flex justify-between items-start">
               <div>
                 <button onClick={() => setSelectedTask(null)} className="text-blue-500 text-sm mb-2 hover:underline">
                   &larr; {t('discovery.backToList')}
                 </button>
                 <h2 className="text-xl font-bold">{selectedTask.name}</h2>
                 <p className="text-sm text-gray-500">{t('discovery.colType')}: {selectedTask.type === 'search' ? t('discovery.typeSearch') : t('discovery.typeParse')} | {t('discovery.colStatus')}: {t(`discovery.status.${selectedTask.status}`)}</p>
               </div>
               <div className="flex gap-2">
                  {['pending', 'paused', 'failed'].includes(selectedTask.status) && (
                    <Button variant="outline" size="sm" onClick={() => handleTaskAction(selectedTask.id, 'start')}><Play className="w-4 h-4" /></Button>
                  )}
                  {['running'].includes(selectedTask.status) && (
                    <Button variant="outline" size="sm" onClick={() => handleTaskAction(selectedTask.id, 'pause')}><Pause className="w-4 h-4" /></Button>
                  )}
                  {['running', 'paused', 'pending'].includes(selectedTask.status) && (
                    <Button variant="outline" size="sm" onClick={() => handleTaskAction(selectedTask.id, 'stop')}><Square className="w-4 h-4" /></Button>
                  )}
                  {selectedTask.type === 'search' && selectedTask.status === 'completed' && (
                    <Button onClick={() => openParseFromSearch(selectedTask)}>
                       {t('discovery.collectAudience')}
                    </Button>
                  )}
               </div>
             </div>

             <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-md">
               <div className="mb-2 text-sm font-medium">{t('discovery.progressLabel')}: {selectedTask.progress} / {selectedTask.total}</div>
               {renderProgressBar(selectedTask.progress, selectedTask.total)}
             </div>

             {selectedTask.type === 'search' && (
               <div>
                 <h3 className="font-medium mb-2">{t('discovery.groupsFoundCount')}: {selectedTask.results?.groups?.length || 0}</h3>
                 <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md">
                   <table className="w-full text-sm text-left">
                     <thead className="bg-gray-50 dark:bg-gray-700">
                       <tr>
                         <th className="p-2">{t('discovery.colId')}</th>
                         <th className="p-2">{t('discovery.colName')}</th>
                         <th className="p-2">{t('discovery.colType')}</th>
                       </tr>
                     </thead>
                     <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                       {(selectedTask.results?.groups || []).map((g: any, i: number) => (
                         <tr key={i}>
                           <td className="p-2 font-mono text-xs">{g.chatId}</td>
                           <td className="p-2">{g.title}</td>
                           <td className="p-2">{g.peerType === 'group' ? t('discovery.typeGroup') : g.peerType === 'channel' ? t('discovery.typeChannel') : g.peerType === 'chat' ? t('discovery.typeChat') : g.peerType}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               </div>
             )}

             {selectedTask.type === 'parse' && (
               <div>
                 <h3 className="font-medium mb-2">{t('discovery.contactsParsedCount')}: {selectedTask.results?.parsed || 0}</h3>
                 <p className="text-sm text-gray-600 dark:text-gray-400">
                   {t('discovery.contactsSavedHint')} {selectedTask.params.campaignId && t('discovery.addToCampaignHint')}
                 </p>
               </div>
             )}
           </div>
        ) : activeTab === 'tasks' ? (
           // Tasks List
           <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
             {loadingTasks ? (
               <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
             ) : tasks.length === 0 ? (
               <div className="p-8 text-center text-gray-500">{t('discovery.noTasks')}</div>
             ) : (
               <>
                 <table className="w-full text-sm text-left">
                   <thead className="bg-gray-50 dark:bg-gray-700">
                     <tr>
                       <th className="p-4">{t('discovery.colName')}</th>
                       <th className="p-4">{t('discovery.colType')}</th>
                       <th className="p-4">{t('discovery.colBdAccount')}</th>
                       <th className="p-4">{t('discovery.colStatus')}</th>
                       <th className="p-4">{t('discovery.colProgress')}</th>
                       <th className="p-4">{t('discovery.colResult')}</th>
                       <th className="p-4">{t('discovery.colDate')}</th>
                       <th className="p-4 w-28">{t('discovery.colActions')}</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                     {tasks.map(task => {
                       const account = task.params?.bdAccountId ? accounts.find((a) => a.id === task.params.bdAccountId) : null;
                       const accountLabel = account ? getAccountDisplayName(account) : '—';
                       const resultLabel = task.type === 'search'
                         ? (task.results?.groups?.length != null ? t('discovery.resultGroups', { count: task.results.groups.length }) : '—')
                         : (task.results?.parsed != null ? t('discovery.resultContacts', { count: task.results.parsed }) : '—');
                       return (
                         <tr key={task.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors" onClick={() => setSelectedTask(task)}>
                           <td className="p-4 font-medium">{task.name}</td>
                           <td className="p-4">
                             <span className={clsx("px-2 py-1 text-xs rounded-full", task.type === 'search' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700')}>
                               {task.type === 'search' ? t('discovery.search') : t('discovery.parse')}
                             </span>
                           </td>
                           <td className="p-4 text-gray-600 dark:text-gray-400">{accountLabel}</td>
                           <td className="p-4">
                             <span className={clsx("px-2 py-1 text-xs rounded-full", 
                               task.status === 'completed' ? 'bg-green-100 text-green-700' : 
                               task.status === 'running' ? 'bg-blue-100 text-blue-700 animate-pulse' :
                               task.status === 'failed' ? 'bg-red-100 text-red-700' :
                               'bg-gray-100 text-gray-700'
                             )}>
                               {t(`discovery.status.${task.status}`)}
                             </span>
                           </td>
                           <td className="p-4 w-48">
                             <div className="flex items-center gap-2">
                               <span className="text-xs text-gray-500 w-12">{task.progress}/{task.total}</span>
                               {renderProgressBar(task.progress, task.total)}
                             </div>
                           </td>
                           <td className="p-4 text-gray-600 dark:text-gray-400">{resultLabel}</td>
                           <td className="p-4 text-gray-500 whitespace-nowrap">
                             {formatDistanceToNow(new Date(task.created_at), { addSuffix: true, locale: ru })}
                           </td>
                           <td className="p-4" onClick={(e) => e.stopPropagation()}>
                             <div className="flex items-center gap-1">
                               {['pending', 'paused', 'failed'].includes(task.status) && (
                                 <Button variant="outline" size="sm" className="p-1.5" onClick={() => handleTaskAction(task.id, 'start')} title={t('discovery.actionStart')}><Play className="w-3.5 h-3.5" /></Button>
                               )}
                               {task.status === 'running' && (
                                 <Button variant="outline" size="sm" className="p-1.5" onClick={() => handleTaskAction(task.id, 'pause')} title={t('discovery.actionPause')}><Pause className="w-3.5 h-3.5" /></Button>
                               )}
                               {['running', 'paused', 'pending'].includes(task.status) && (
                                 <Button variant="outline" size="sm" className="p-1.5" onClick={() => handleTaskAction(task.id, 'stop')} title={t('discovery.actionStop')}><Square className="w-3.5 h-3.5" /></Button>
                               )}
                             </div>
                           </td>
                         </tr>
                       );
                     })}
                   </tbody>
                 </table>
                 {taskTotal > TASKS_PAGE_SIZE && (
                   <div className="px-6 py-4 border-t border-border">
                     <Pagination
                       page={taskPage}
                       totalPages={Math.ceil(taskTotal / TASKS_PAGE_SIZE)}
                       onPageChange={setTaskPage}
                     />
                   </div>
                 )}
               </>
             )}
           </div>
        ) : activeTab === 'new_search' ? (
           // New Search Task Form
           <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow max-w-2xl space-y-6">
             <div>
               <label className="block text-sm font-medium mb-1">{t('discovery.taskName')}</label>
               <SearchInput value={typeof searchName === 'string' ? searchName : ''} onChange={(e) => setSearchName(e.target.value)} placeholder={t('discovery.taskNamePlaceholder')} className="w-full" />
             </div>
             
             <div>
                <label className="block text-sm font-medium mb-1">{t('discovery.bdAccount')}</label>
                <select
                  value={searchAccountId}
                  onChange={(e) => setSearchAccountId(e.target.value)}
                  className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800"
                >
                  <option value="" disabled>{t('discovery.selectAccount')}</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{getAccountDisplayName(a)}</option>)}
                </select>
             </div>

             <div>
                <label className="block text-sm font-medium mb-1">{t('discovery.whatSearch')}</label>
                <select
                  value={searchType}
                  onChange={(e) => setSearchType(e.target.value as SearchType)}
                  className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800"
                >
                  <option value="all">{t('discovery.typeAll')}</option>
                  <option value="groups">{t('discovery.typeGroups')}</option>
                  <option value="channels">{t('discovery.typeChannels')}</option>
                </select>
             </div>

             <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-md border border-blue-100 dark:border-blue-800">
                <label className="block text-sm font-medium text-blue-900 dark:text-blue-100 mb-2">
                  <Sparkles className="w-4 h-4 inline-block mr-1" /> {t('discovery.aiQueriesLabel')}
                </label>
                <div className="flex gap-2">
                  <SearchInput value={typeof aiTopic === 'string' ? aiTopic : ''} onChange={(e) => setAiTopic(e.target.value)} placeholder={t('discovery.topicPlaceholder')} className="flex-1" />
                  <Button onClick={handleGenerateQueries} disabled={aiLoading || !aiTopic}>
                    {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('discovery.generateQueries')}
                  </Button>
                </div>
             </div>

             <div>
               <label className="block text-sm font-medium mb-1">{t('discovery.queriesLabel')}</label>
               <textarea
                 value={queriesText}
                 onChange={(e) => setQueriesText(e.target.value)}
                 placeholder={t('discovery.queriesPlaceholder')}
                 className="w-full h-32 p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800"
               />
               <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                 {t('discovery.queriesHint')}
               </p>
             </div>

             <Button onClick={handleCreateSearchTask} className="w-full justify-center">{t('discovery.startSearch')}</Button>
           </div>
        ) : (
           // New Parse Flow (smart resolve + strategy)
           <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow max-w-2xl space-y-6">
             {parseStep === 1 && (
               <>
                 <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('discovery.step1')}</h3>
                 <ParseSourceInput
                   bdAccountId={parseResolveAccountId}
                   onBdAccountIdChange={setParseResolveAccountId}
                   accountOptions={accounts.map((a) => ({ id: a.id, label: getAccountDisplayName(a) || a.id }))}
                   onResolve={handleParseResolve}
                 />
               </>
             )}
             {parseStep === 2 && (
               <>
                 <div className="flex items-center justify-between">
                   <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('discovery.step2')}</h3>
                   <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => { setParseStep(1); setResolvedSources([]); }}>{t('discovery.changeSources')}</button>
                 </div>
                 <div className="space-y-2 max-h-48 overflow-y-auto">
                   {resolvedSources.map((s, i) => (
                     <SourceTypeCard key={i} source={s} />
                   ))}
                 </div>
                 <ParseSettingsForm
                   sources={resolvedSources}
                   accountOptions={accounts.map((a) => ({ id: a.id, label: getAccountDisplayName(a) || a.id }))}
                   selectedAccountIds={parseAccountIds}
                   onAccountIdsChange={setParseAccountIds}
                   depth={parseDepth}
                   onDepthChange={setParseDepth}
                   excludeAdmins={parseExcludeAdmins}
                   onExcludeAdminsChange={setParseExcludeAdmins}
                   listName={parseListName}
                   onListNameChange={setParseListName}
                   createCampaign={parseCreateCampaign}
                   onCreateCampaignChange={setParseCreateCampaign}
                   onStart={handleParseStart}
                   starting={parseStarting}
                 />
               </>
             )}
             {parseStep === 3 && parseTaskId && (
               <>
                 <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('discovery.step3Progress')}</h3>
                 <ParseProgressPanel taskId={parseTaskId} onStopped={handleParseProgressStopped} />
               </>
             )}
             {parseStep === 4 && parseResult && (
               <>
                 <ParseResultSummary
                   result={parseResult}
                   onRunAgain={handleParseRunAgain}
                 />
               </>
             )}
           </div>
        )}
      </div>
    </div>
  );
}

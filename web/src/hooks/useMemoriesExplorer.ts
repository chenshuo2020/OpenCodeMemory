import { useCallback, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { t } from "$lib/i18n";
import type { MemoryItem, TagInfo } from "$lib/types";

export function useMemoriesExplorer() {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedTag, setSelectedTag] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [statsTotal, setStatsTotal] = useState(0);
  const [loadingMemories, setLoadingMemories] = useState(true);
  const [memoriesError, setMemoriesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAuthWarning, setShowAuthWarning] = useState(false);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState("");
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState("");
  const [editContent, setEditContent] = useState("");
  const [addTag, setAddTag] = useState("");
  const [addType, setAddType] = useState("");
  const [addTags, setAddTags] = useState("");
  const [addContent, setAddContent] = useState("");

  const stateRef = useRef({
    currentPage,
    isSearching,
    searchQuery,
    selectedTag,
  });
  stateRef.current = { currentPage, isSearching, searchQuery, selectedTag };

  const setSelected = useCallback((next: Set<string>) => {
    setSelectedIds(new Set(next));
  }, []);

  const loadTags = useCallback(async () => {
    const result = await fetchAPI<{ project: TagInfo[] }>("/api/tags");
    if (result.success && result.data) {
      setTags(result.data.project || []);
    }
  }, []);

  const loadStats = useCallback(async () => {
    const result = await fetchAPI<{ total: number }>("/api/stats");
    if (result.success && result.data) {
      setStatsTotal(result.data.total);
    }
  }, []);

  const loadMemories = useCallback(
    async (overrides?: {
      page?: number;
      isSearching?: boolean;
      searchQuery?: string;
      selectedTag?: string;
    }) => {
      const {
        currentPage: page,
        isSearching: searching,
        searchQuery: query,
        selectedTag: tag,
      } = {
        ...stateRef.current,
        ...overrides,
        currentPage: overrides?.page ?? stateRef.current.currentPage,
      };

      setRefreshing(true);
      setMemoriesError(null);
      let endpoint = `/api/memories?page=${page}&pageSize=20&includePrompts=true`;
      if (searching) {
        endpoint = `/api/search?q=${encodeURIComponent(query)}&page=${page}&pageSize=20`;
        if (tag) endpoint += `&tag=${encodeURIComponent(tag)}`;
      } else if (tag) {
        endpoint += `&tag=${encodeURIComponent(tag)}`;
      }

      const result = await fetchAPI<{
        items: MemoryItem[];
        totalPages: number;
        total: number;
        page: number;
      }>(endpoint);
      setRefreshing(false);
      setLoadingMemories(false);

      if (result.success && result.data) {
        setMemories(result.data.items);
        setTotalPages(result.data.totalPages);
        setTotalItems(result.data.total);
        setCurrentPage(result.data.page);
      } else {
        setMemoriesError(result.error || t("toast-update-failed"));
      }
    },
    []
  );

  const checkMigrationStatus = useCallback(async () => {
    const result = await fetchAPI<{
      needsMigration: boolean;
      configDimensions: number;
      configModel: string;
      shardMismatches: unknown[];
    }>("/api/migration/detect");
    if (result.success && result.data?.needsMigration) {
      const shardInfo =
        result.data.shardMismatches.length > 0
          ? t("migration-shards-mismatch", { count: result.data.shardMismatches.length })
          : t("migration-dimension-mismatch");
      setMigrationMessage(
        t("migration-mismatch-details", {
          configDimensions: result.data.configDimensions,
          configModel: result.data.configModel,
          shardInfo,
        })
      );
      setMigrationNeeded(true);
    }
  }, []);

  const checkAuthWarning = useCallback(async () => {
    try {
      const response = await fetch("/api/health", { credentials: "same-origin" });
      if (!response.ok) return;
      const data = await response.json();
      const authEnabled = data?.authEnabled === true;
      if (authEnabled) {
        setShowAuthWarning(false);
        return;
      }
      const host = window.location.hostname.toLowerCase();
      const loopback =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "::1" ||
        (host.startsWith("::ffff:") && host.endsWith("127.0.0.1"));
      setShowAuthWarning(!loopback);
    } catch {
      /* ignore */
    }
  }, []);

  function performSearch() {
    const query = searchInput.trim();
    if (!query) {
      clearSearch();
      return;
    }
    setSearchQuery(query);
    setIsSearching(true);
    setCurrentPage(1);
    void loadMemories({
      page: 1,
      isSearching: true,
      searchQuery: query,
    });
  }

  function clearSearch() {
    setSearchQuery("");
    setSearchInput("");
    setIsSearching(false);
    setCurrentPage(1);
    void loadMemories({
      page: 1,
      isSearching: false,
      searchQuery: "",
    });
  }

  function onTagFilterChange(value: string) {
    setSelectedTag(value);
    setCurrentPage(1);
    setIsSearching(false);
    setSearchQuery("");
    setSearchInput("");
    void loadMemories({
      page: 1,
      isSearching: false,
      searchQuery: "",
      selectedTag: value,
    });
  }

  function onSelect(id: string, selected: boolean) {
    const next = new Set(selectedIds);
    if (selected) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  function selectAllCurrentPage() {
    const next = new Set(selectedIds);
    for (const m of memories) next.add(m.id);
    setSelected(next);
  }

  function deselectAll() {
    setSelected(new Set());
  }

  async function addMemory(e: FormEvent) {
    e.preventDefault();
    const content = addContent.trim();
    if (!content || !addTag) {
      toast.error(t("toast-add-error"));
      return;
    }
    const tagsList = addTags
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const result = await fetchAPI("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        containerTag: addTag,
        type: addType || undefined,
        tags: tagsList,
      }),
    });
    if (result.success) {
      toast.success(t("toast-add-success"));
      setAddContent("");
      setAddTags("");
      setAddType("");
      await loadMemories();
      await loadStats();
    } else {
      toast.error(result.error || t("toast-add-failed"));
    }
  }

  function openEdit(id: string) {
    const memory = memories.find((m) => m.id === id && m.type === "memory");
    if (!memory) return;
    setEditId(id);
    setEditContent(memory.content);
    setEditOpen(true);
  }

  async function saveEdit(content: string) {
    const result = await fetchAPI(`/api/memories/${editId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (result.success) {
      toast.success(t("toast-update-success"));
      setEditOpen(false);
      await loadMemories();
    } else {
      toast.error(result.error || t("toast-update-failed"));
    }
  }

  async function deleteMemory(id: string, isLinked: boolean) {
    if (!confirm(isLinked ? t("confirm-delete-pair") : t("confirm-delete"))) return;
    const result = await fetchAPI(`/api/memories/${id}?cascade=true`, {
      method: "DELETE",
    });
    if (result.success) {
      toast.success(t("toast-delete-success"));
      const next = new Set(selectedIds);
      next.delete(id);
      setSelected(next);
      await loadMemories();
      await loadStats();
    } else {
      toast.error(result.error || t("toast-delete-failed"));
    }
  }

  async function deletePrompt(id: string, isLinked: boolean) {
    if (!confirm(isLinked ? t("confirm-delete-prompt") : t("confirm-delete"))) return;
    const result = await fetchAPI(`/api/prompts/${id}?cascade=true`, {
      method: "DELETE",
    });
    if (result.success) {
      toast.success(t("toast-delete-success"));
      const next = new Set(selectedIds);
      next.delete(id);
      setSelected(next);
      await loadMemories();
      await loadStats();
    } else {
      toast.error(result.error || t("toast-delete-failed"));
    }
  }

  async function bulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(t("confirm-bulk-delete", { count: selectedIds.size }))) return;
    const ids = Array.from(selectedIds);
    const promptIds = ids.filter((id) => id.startsWith("prompt_"));
    const memoryIds = ids.filter((id) => !id.startsWith("prompt_"));
    if (promptIds.length > 0) {
      await fetchAPI("/api/prompts/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: promptIds, cascade: true }),
      });
    }
    if (memoryIds.length > 0) {
      await fetchAPI("/api/memories/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: memoryIds, cascade: true }),
      });
    }
    toast.success(t("toast-bulk-delete-success"));
    setSelected(new Set());
    await loadMemories();
    await loadStats();
  }

  async function pinMemory(id: string) {
    const result = await fetchAPI(`/api/memories/${id}/pin`, { method: "POST" });
    if (result.success) {
      toast.success(t("toast-update-success"));
      await loadMemories();
    } else toast.error(result.error || t("toast-update-failed"));
  }

  async function unpinMemory(id: string) {
    const result = await fetchAPI(`/api/memories/${id}/unpin`, { method: "POST" });
    if (result.success) {
      toast.success(t("toast-update-success"));
      await loadMemories();
    } else toast.error(result.error || t("toast-update-failed"));
  }

  async function runCleanup() {
    if (!confirm(t("confirm-cleanup"))) return;
    toast.info(t("status-cleanup"));
    const result = await fetchAPI("/api/cleanup", { method: "POST" });
    if (result.success) {
      toast.success(t("toast-cleanup-success"));
      await loadMemories();
      await loadStats();
    } else toast.error(result.error || t("toast-cleanup-failed"));
  }

  async function runDeduplication() {
    if (!confirm(t("confirm-dedup"))) return;
    toast.info(t("status-dedup"));
    const result = await fetchAPI("/api/deduplicate", { method: "POST" });
    if (result.success) {
      toast.success(t("toast-dedup-success"));
      await loadMemories();
      await loadStats();
    } else toast.error(result.error || t("toast-dedup-failed"));
  }

  async function runMigration(strategy: "fresh-start" | "re-embed") {
    if (!migrationConfirmed) {
      toast.error(t("toast-migration-failed"));
      return;
    }
    const strategyName =
      strategy === "fresh-start" ? "Fresh Start (Delete All)" : "Re-embed (Preserve Data)";
    if (
      !confirm(`Run ${strategyName} migration?\n\nThis operation is IRREVERSIBLE.\n\nContinue?`)
    ) {
      return;
    }
    toast.info(t("status-migration-init"));
    const result = await fetchAPI("/api/migration/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy }),
    });
    if (result.success) {
      toast.success(t("toast-migration-success"));
      setMigrationNeeded(false);
      setMigrationConfirmed(false);
      await loadMemories();
      await loadStats();
    } else toast.error(result.error || t("toast-migration-failed"));
  }

  return {
    tags,
    memories,
    selectedIds,
    selectedTag,
    searchInput,
    setSearchInput,
    isSearching,
    currentPage,
    setCurrentPage,
    totalPages,
    totalItems,
    statsTotal,
    loadingMemories,
    memoriesError,
    refreshing,
    showAuthWarning,
    migrationNeeded,
    migrationMessage,
    migrationConfirmed,
    setMigrationConfirmed,
    editOpen,
    setEditOpen,
    editContent,
    addTag,
    setAddTag,
    addType,
    setAddType,
    addTags,
    setAddTags,
    addContent,
    setAddContent,
    loadTags,
    loadStats,
    loadMemories,
    checkMigrationStatus,
    checkAuthWarning,
    performSearch,
    clearSearch,
    onTagFilterChange,
    onSelect,
    selectAllCurrentPage,
    deselectAll,
    addMemory,
    openEdit,
    saveEdit,
    deleteMemory,
    deletePrompt,
    bulkDelete,
    pinMemory,
    unpinMemory,
    runCleanup,
    runDeduplication,
    runMigration,
  };
}

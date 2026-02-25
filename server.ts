import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { Database } from "bun:sqlite";

const DATA_ROOT = "../WutheringData";
const DATA_CONFIG_ROOT = `${DATA_ROOT}/ConfigDB`;
const DATA_TEXTMAP_ROOT = `${DATA_ROOT}/TextMap/en`;

// --- Data Loading ---

async function loadTextMap(): Promise<Record<string, string>> {
	const [a, b] = await Promise.all([
		Bun.file(`${DATA_TEXTMAP_ROOT}/MultiText.json`).json(),
		Bun.file(`${DATA_TEXTMAP_ROOT}/MultiText_1sthalf.json`).json(),
	]);
	return { ...a, ...b };
}

async function loadJson<T = any>(filename: string): Promise<T[]> {
	return Bun.file(`${DATA_CONFIG_ROOT}/${filename}`).json();
}

console.log("Loading data...");
const [textMap, questsRaw, questNodesRaw, flowStatesRaw, speakersRaw] = await Promise.all([
	loadTextMap(),
	loadJson<{ QuestId: number; Data: string }>("QuestData.json"),
	loadJson<{ Key: string; Data: string }>("QuestNodeData.json"),
	loadJson<{ StateKey: string; Id: number; Actions: string }>("FlowState.json"),
	loadJson<{ Id: number; Name: number }>("Speaker.json"),
]);

function t(key: string | number): string {
	return textMap[String(key)] ?? String(key);
}

// --- Build Indexes ---

// Speaker map: WhoId -> display name
const speakerMap = new Map<number, string>();
for (const sp of speakersRaw) {
	const name = textMap[`Speaker_${sp.Id}_Name`];
	if (name) speakerMap.set(sp.Id, name);
}

// FlowState map: StateKey -> parsed actions array
const flowStateMap = new Map<string, any[]>();
for (const fs of flowStatesRaw) {
	try {
		flowStateMap.set(fs.StateKey, JSON.parse(fs.Actions));
	} catch {}
}

// Parse quest data once (avoid double JSON.parse)
const questDataParsed = questsRaw.map((raw) => JSON.parse(raw.Data));

// Parse quests
interface QuestInfo {
	id: number;
	name: string;
	description: string;
	type: string;
	typeId: number;
	chapterName: string;
	chapterNum: string;
	sectionNum: string;
	actName: string;
	chapterId: number;
	key: string;
	children: any[];
}

const quests: QuestInfo[] = [];
const questMap = new Map<number, QuestInfo>();

// Quest chain: prev/next from PreQuest conditions
const questPrevMap = new Map<number, number[]>(); // questId -> prerequisite quest ids
const questNextMap = new Map<number, number[]>(); // questId -> quests that require this

function mapAppend<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const arr = map.get(key);
	if (arr) arr.push(value);
	else map.set(key, [value]);
}

for (const data of questDataParsed) {
	// Build quest info
	const name = textMap[data.TidName];
	if (name) {
		const info: QuestInfo = {
			id: data.Id,
			name,
			description: t(data.TidDesc),
			type: t(`QuestType_${data.Type}_QuestTypeName`),
			typeId: data.Type,
			chapterName: t(`QuestChapter_${data.ChapterId}_ChapterName`),
			chapterNum: t(`QuestChapter_${data.ChapterId}_ChapterNum`),
			sectionNum: t(`QuestChapter_${data.ChapterId}_SectionNum`),
			actName: t(`QuestChapter_${data.ChapterId}_ActName`),
			chapterId: data.ChapterId ?? 0,
			key: data.Key,
			children: data.Children,
		};
		quests.push(info);
		questMap.set(info.id, info);
	}

	// Build quest chain links
	const conditions = data.ProvideType?.Conditions ?? [];
	for (const cond of conditions) {
		if (cond.Type === "PreQuest" && cond.PreQuest) {
			mapAppend(questPrevMap, data.Id, cond.PreQuest);
			mapAppend(questNextMap, cond.PreQuest, data.Id);
		}
	}
}

// Quest types for filtering
const questTypes = [...new Set(quests.map((q) => q.type))].sort();

function getQuestChainLinks(questId: number) {
	const prevIds = questPrevMap.get(questId) ?? [];
	const nextIds = questNextMap.get(questId) ?? [];

	const toLink = (id: number) => {
		const q = questMap.get(id);
		return q ? { id: q.id, name: q.name, type: q.type } : { id, name: null, type: null };
	};

	return {
		prev: prevIds.map(toLink).filter((l) => l.name),
		next: nextIds.map(toLink).filter((l) => l.name),
	};
}

// QuestNode index: questId -> parsed nodes (file insertion order = execution order)
const questNodeIndex = new Map<number, any[]>();
for (const raw of questNodesRaw) {
	const underscoreIdx = raw.Key.indexOf("_");
	const questId = Number(raw.Key.substring(0, underscoreIdx));
	if (!questNodeIndex.has(questId)) questNodeIndex.set(questId, []);
	questNodeIndex.get(questId)!.push(JSON.parse(raw.Data));
}

console.log(
	`Loaded: ${quests.length} quests, ${questNodesRaw.length} nodes, ${flowStatesRaw.length} flow states, ${speakersRaw.length} speakers`,
);

// --- Quest Objectives ---

interface QuestObjective {
	nodeId: number;
	text: string;
	conditionType: string;
}

function getQuestObjectives(questId: number): QuestObjective[] {
	const nodes = questNodeIndex.get(questId);
	if (!nodes) return [];

	const objectives: QuestObjective[] = [];
	for (const node of nodes) {
		if (node.Type !== "ChildQuest") continue;
		if (node.HideUi || node.HideTip) continue;
		const tipText = node.TidTip ? textMap[node.TidTip] : "";
		if (!tipText) continue;
		objectives.push({
			nodeId: node.Id,
			text: tipText,
			conditionType: node.Condition?.Type ?? "",
		});
	}
	return objectives;
}

// --- Dialog Extraction ---

// Types for dialog items within a group
interface DialogItemBase {
	id?: number;
	jumpTo?: number;
	options?: { text: string; jumpTo?: number }[];
}

type DialogItem =
	| (DialogItemBase & { kind: "talk"; speaker: string; text: string; whoId: number })
	| (DialogItemBase & { kind: "centerText"; text: string })
	| (DialogItemBase & { kind: "cutscene"; videoName: string })
	| (DialogItemBase & { kind: "narration"; text: string });

type DialogTreeNode =
	| DialogItem
	| { kind: "branch"; prompt: DialogItem; options: { text: string; items: DialogTreeNode[] }[] };

function extractItemsFromActions(actions: any[]): DialogItem[] {
	const items: DialogItem[] = [];

	for (const action of actions) {
		if (action.Name === "PlayMovie") {
			items.push({ kind: "cutscene", videoName: action.Params?.VideoName ?? "unknown" });
			continue;
		}

		if (action.Name === "ShowCenterText") {
			const text = action.Params?.TidText ? t(action.Params.TidText) : "";
			if (text) items.push({ kind: "centerText", text });
			continue;
		}

		if (action.Name !== "ShowTalk") continue;

		const talkItems = action.Params?.TalkItems;
		if (!Array.isArray(talkItems)) continue;

		for (const item of talkItems) {
			const type = item.Type ?? "Talk";

			// Skip non-text items
			if (type === "NoTextItem" || type === "QTE") continue;

			if (type === "CenterText") {
				const text = item.TidTalk ? t(item.TidTalk) : "";
				if (text) items.push({ kind: "centerText", text });
				continue;
			}

			// Talk, Option, SystemOption, PhoneMessage, undefined — treat as dialog
			const speaker = item.WhoId != null ? (speakerMap.get(item.WhoId) ?? `Unknown (${item.WhoId})`) : "";
			const text = item.TidTalk ? t(item.TidTalk) : "";
			if (!text) continue;

			const jumpAction = item.Actions?.find((a: any) => a.Name === "JumpTalk");
			const jumpTo = jumpAction?.Params?.TalkId as number | undefined;
			const options = item.Options?.length
				? item.Options.map((opt: any) => ({
						jumpTo: opt.Actions?.find((a: any) => a.Name === "JumpTalk")?.Params?.TalkId as number | undefined,
						text: t(opt.TidTalkOption),
					}))
				: undefined;

			const line: DialogItem = speaker
				? { kind: "talk", speaker, text, whoId: item.WhoId, id: item.Id, jumpTo, options }
				: { kind: "narration", text, id: item.Id, jumpTo, options };

			items.push(line);
		}
	}

	return items;
}

function buildDialogTree(items: DialogItem[]): DialogTreeNode[] {
	if (items.length === 0) return [];

	// Build id -> item lookup and id -> index for ordering
	const idToItem = new Map<number, DialogItem>();
	const idToIndex = new Map<number, number>();
	for (const [i, item] of items.entries()) {
		if (item.id != null) {
			idToItem.set(item.id, item);
			idToIndex.set(item.id, i);
		}
	}

	function getItemAt(idx: number): DialogItem | undefined {
		return idx >= 0 && idx < items.length ? items[idx] : undefined;
	}

	// Determine the next index to follow from an item
	function nextIdx(item: DialogItem, idx: number): number {
		if (item.jumpTo != null && idToIndex.has(item.jumpTo)) {
			return idToIndex.get(item.jumpTo) ?? idx + 1;
		}
		if (item.options?.length) {
			const targets = [...new Set(item.options.map((o) => o.jumpTo).filter((j): j is number => j != null))];
			const [singleTarget] = targets;
			if (targets.length === 1 && singleTarget != null) {
				return idToIndex.get(singleTarget) ?? idx + 1;
			}
		}
		return idx + 1;
	}

	// Trace forward from a given index, collecting all visited item IDs
	function tracePath(startIdx: number): number[] {
		const visited: number[] = [];
		const seen = new Set<number>();
		let idx = startIdx;
		let item = getItemAt(idx);
		while (item) {
			if (item.id != null) {
				if (seen.has(item.id)) break;
				seen.add(item.id);
				visited.push(item.id);
			}
			idx = nextIdx(item, idx);
			item = getItemAt(idx);
		}
		return visited;
	}

	// Find the convergence point where all branches rejoin
	function findConvergence(branchTargets: number[]): number | null {
		const branchSet = new Set(branchTargets);
		const paths = branchTargets.map((targetId) => {
			const idx = idToIndex.get(targetId);
			return idx != null ? tracePath(idx) : [];
		});
		if (paths.length === 0) return null;

		const pathSets = paths.map((p) => new Set(p));
		// Walk in array order to find first common element not in branch starts
		for (const { id } of items) {
			if (id == null || branchSet.has(id)) continue;
			if (pathSets.every((s) => s.has(id))) return id;
		}
		return null;
	}

	// Recursively walk items building the tree, stopping at any ID in stopIds
	function walk(startIdx: number, stopIds: Set<number>, visited = new Set<number>()): DialogTreeNode[] {
		const result: DialogTreeNode[] = [];
		let idx = startIdx;
		let item = getItemAt(idx);

		while (item) {
			if (item.id != null && stopIds.has(item.id)) break;

			if (item.id != null) {
				if (visited.has(item.id)) break;
				visited.add(item.id);
			}

			const distinctTargets = item.options
				? [...new Set(item.options.map((o) => o.jumpTo).filter((j): j is number => j != null))]
				: [];

			if (distinctTargets.length >= 2 && item.options) {
				const convergenceId = findConvergence(distinctTargets);
				const branchStopIds = new Set(stopIds);
				if (convergenceId != null) branchStopIds.add(convergenceId);

				result.push({
					kind: "branch",
					prompt: item,
					options: item.options.map((opt) => ({
						text: opt.text,
						items:
							opt.jumpTo != null && idToIndex.has(opt.jumpTo)
								? walk(idToIndex.get(opt.jumpTo) ?? -1, branchStopIds, visited)
								: [],
					})),
				});

				if (convergenceId != null) {
					idx = idToIndex.get(convergenceId) ?? -1;
					item = getItemAt(idx);
					continue;
				}
				break;
			}

			result.push(item);
			idx = nextIdx(item, idx);
			item = getItemAt(idx);
		}

		return result;
	}

	return walk(0, new Set());
}

interface DialogGroup {
	stepLabel: string;
	nodeId: number;
	nodeDesc: string;
	items: DialogTreeNode[];
}

function getDialogGroups(questId: number): DialogGroup[] {
	const nodes = questNodeIndex.get(questId);
	if (!nodes) return [];

	const groups: DialogGroup[] = [];
	for (const node of nodes) {
		if (node.Type !== "ChildQuest" || node.Condition?.Type !== "PlayFlow") continue;
		const flow = node.Condition.Flow;
		if (!flow) continue;

		const stateKey = `${flow.FlowListName}_${flow.FlowId}_${flow.StateId}`;
		const actions = flowStateMap.get(stateKey);
		if (!actions) continue;

		const rawItems = extractItemsFromActions(actions);
		if (rawItems.length === 0) continue;

		const treeItems = buildDialogTree(rawItems);

		const tipText = node.TidTip ? textMap[node.TidTip] : undefined;
		const resolvedTip = tipText && !tipText.startsWith("Quest_") ? tipText : "";
		const firstTalk = rawItems.find((i) => i.kind === "talk") as Extract<DialogItem, { kind: "talk" }> | undefined;
		const firstSpeaker = firstTalk ? `${firstTalk.speaker}: "${firstTalk.text.slice(0, 60)}..."` : "";
		const stepLabel = resolvedTip || node.Desc || firstSpeaker || `Step ${node.Id}`;

		groups.push({ stepLabel, nodeId: node.Id, nodeDesc: node.Desc ?? "", items: treeItems });
	}

	return groups;
}

// --- Hono App ---

const app = new Hono();

// API routes
app.get("/api/quests", (c) => {
	const q = (c.req.query("q") ?? "").toLowerCase();
	const type = c.req.query("type") ?? "";
	const page = Math.max(1, Number(c.req.query("page") ?? "1"));
	const pageSize = 50;

	let filtered = quests;

	if (q) {
		filtered = filtered.filter((quest) => quest.name.toLowerCase().includes(q));
	}
	if (type) {
		filtered = filtered.filter((quest) => quest.type === type);
	}

	const total = filtered.length;
	const results = filtered.slice((page - 1) * pageSize, page * pageSize);

	return c.json({ results, total, page, pageSize });
});

app.get("/api/quests/:id", (c) => {
	const id = Number(c.req.param("id"));
	const quest = questMap.get(id);
	if (!quest) return c.json({ error: "Quest not found" }, 404);

	console.log(quest);

	const raw =
		questNodeIndex
			.get(id)
	// const nodesByType = raw ? raw.reduce((acc, node) => {
	// 	if (!acc[node.Type]) acc[node.Type] = [];
	// 	acc[node.Type].push(node);
	// 	return acc;
	// }, {} as Record<string, any[]>) : {};

	const objectives = getQuestObjectives(id);
	const dialog = getDialogGroups(id);
	const chain = getQuestChainLinks(id);
	return c.json({ quest, objectives, dialog, chain, raw });
});

app.get("/api/quest-types", (c) => {
	return c.json(questTypes);
});

app.get("/api/translate/:text", (c) => {
	const key = c.req.param("text");
	return c.json({ key, translation: t(key) });
});

// --- Word Cloud API (SQLite-backed) ---

const db = new Database("./quests.db", { readonly: true });

const STOP_WORDS = new Set([
	"i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your", "yours",
	"yourself", "yourselves", "he", "him", "his", "himself", "she", "her", "hers", "herself",
	"it", "its", "itself", "they", "them", "their", "theirs", "themselves", "what", "which",
	"who", "whom", "this", "that", "these", "those", "am", "is", "are", "was", "were", "be",
	"been", "being", "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an",
	"the", "and", "but", "if", "or", "because", "as", "until", "while", "of", "at", "by",
	"for", "with", "about", "against", "between", "through", "during", "before", "after",
	"above", "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under",
	"again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "all",
	"both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only",
	"own", "same", "so", "than", "too", "very", "s", "t", "can", "will", "just", "don", "don't",
	"should", "now", "d", "ll", "m", "o", "re", "ve", "y", "ain", "aren", "couldn", "didn",
	"doesn", "hadn", "hasn", "haven", "isn", "ma", "mightn", "mustn", "needn", "shan", "shouldn",
	"wasn", "weren", "won", "wouldn", "let", "us", "go", "get", "got", "would", "could", "also",
	"still", "much", "well", "back", "even", "come", "like", "know", "think", "make", "right",
	"want", "need", "say", "tell", "see", "look", "one", "way", "may", "might", "shall",
	// contractions
	"i'm", "it's", "that's", "what's", "there's", "here's", "he's", "she's", "who's", "how's",
	"where's", "when's", "why's", "let's", "won't", "can't", "couldn't", "wouldn't",
	"shouldn't", "didn't", "doesn't", "don't", "isn't", "aren't", "wasn't", "weren't",
	"hasn't", "haven't", "hadn't", "mustn't", "needn't", "shan't", "won't", "they're",
	"we're", "you're", "we've", "you've", "they've", "we'll", "you'll", "they'll",
	"he'll", "she'll", "it'll", "we'd", "you'd", "they'd", "he'd", "she'd", "it'd",
	"that'll", "who'll", "what'll", "there'll", "here'll",
]);

const stmtSpeakers = db.prepare(
	"SELECT speaker_name, count(*) as line_count FROM dialog_lines WHERE speaker_name != '' GROUP BY speaker_name ORDER BY line_count DESC"
);

const stmtLines = db.prepare(
	"SELECT text FROM dialog_lines WHERE speaker_name = ?"
);

app.get("/api/speakers", (c) => {
	return c.json(stmtSpeakers.all());
});

app.get("/api/speakers/:name/words", (c) => {
	const name = decodeURIComponent(c.req.param("name"));
	const limit = Math.min(Number(c.req.query("limit") ?? "100"), 5000);
	const lines = stmtLines.all(name) as { text: string }[];

	const freq = new Map<string, number>();
	for (const { text } of lines) {
		const words = text.toLowerCase().replace(/[^a-z'-]/g, " ").split(/\s+/);
		for (const w of words) {
			if (w.length < 2 || STOP_WORDS.has(w)) continue;
			freq.set(w, (freq.get(w) ?? 0) + 1);
		}
	}

	const sorted = [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([word, count]) => ({ word, count }));

	return c.json(sorted);
});

const stmtLinesByWord = db.prepare(
	"SELECT dl.text, q.name as quest_name, q.id as quest_id FROM dialog_lines dl JOIN quests q ON q.id = dl.quest_id WHERE dl.speaker_name = ? AND lower(dl.text) LIKE ? ORDER BY dl.quest_id, dl.sort_order"
);

app.get("/api/speakers/:name/lines", (c) => {
	const name = decodeURIComponent(c.req.param("name"));
	const word = (c.req.query("word") ?? "").toLowerCase().trim();
	if (!word) return c.json([]);
	const rows = stmtLinesByWord.all(name, `%${word}%`);
	return c.json(rows);
});

// Static files
app.use("/*", serveStatic({ root: "./public" }));

export default {
	port: 3000,
	fetch: app.fetch,
};

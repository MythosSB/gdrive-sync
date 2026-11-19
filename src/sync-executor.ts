import { App, Platform, TFile } from "obsidian";
import { AuthExpiredError } from "./auth";
import type { DriveClient, DriveFile } from "./drive";
import { md5Hex } from "./hash";
import type { SyncAction } from "./planner";
import type { SyncProgress } from "./progress";
import type { PlanResult } from "./sync";
import { saveState, SyncState } from "./sync-state";

const MAX_DELETIONS = 10; // más borrados que esto piden confirmación
const CONCURRENCY = Platform.isMobile ? 2 : 3; // transferencias a la vez

type ActionOf<T extends SyncAction["type"]> = Extract<SyncAction, { type: T }>;

// Se lanza cuando el plan incluye demasiados borrados y hay que confirmar.
export class MassDeletionError extends Error {
	constructor(public count: number) {
		super(`La sincronización quiere borrar ${count} archivos`);
		this.name = "MassDeletionError";
	}
}

export interface SyncReport {
	uploaded: number;
	downloaded: number;
	conflicts: number;
	deletedLocal: number;
	deletedRemote: number;
	skipped: number;
	errors: string[];
}

interface RunContext {
	plan: PlanResult;
	state: SyncState;
	rootId: string;
	report: SyncReport;
	progress?: SyncProgress;
}

// ---------- Utilidades ----------

const MIME_TYPES: Record<string, string> = {
	md: "text/markdown",
	txt: "text/plain",
	csv: "text/csv",
	html: "text/html",
	json: "application/json",
	canvas: "application/json",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
};

function mimeFor(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

function parentDir(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

// Fecha para los nombres de conflicto: 2026-11-16 1332
function stamp(date: Date): string {
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}${pad(date.getMinutes())}`
	);
}

// Ejecuta `worker` sobre cada elemento, con un máximo de `limit` a la vez.
async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	let stopped = false;

	const runner = async () => {
		while (!stopped && next < items.length) {
			const item = items[next++];
			if (item === undefined) continue;
			try {
				await worker(item);
			} catch (error) {
				stopped = true; // un error grave (p. ej. sesión caducada) detiene a todos
				throw error;
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => runner())
	);
}

// ---------- Ejecutor ----------

export class SyncExecutor {
	private running = false;

	constructor(
		private app: App,
		private drive: DriveClient,
		private getFolderName: () => string,
		private getStatePath: () => string
	) {}

	async execute(
				plan: PlanResult,
		options: { allowMassDelete?: boolean } = {},
		progress?: SyncProgress
	): Promise<SyncReport> {
		if (this.running) throw new Error("Ya hay una sincronización en curso");

		// ----- Comprobaciones de seguridad, antes de tocar nada -----
		const knownFiles = Object.keys(plan.state.files).length;
		if (plan.local.size === 0 && knownFiles > 0) {
			throw new Error(
				`La bóveda aparece vacía, pero antes tenía ${knownFiles} archivos sincronizados. ` +
					"Se canceló por seguridad. Si es intencional, borra sync-state.json del plugin."
			);
		}
		const deletions = plan.actions.filter(
			(a) => a.type === "delete-local" || a.type === "delete-remote"
		).length;
		if (deletions > MAX_DELETIONS && !options.allowMassDelete) {
			throw new MassDeletionError(deletions);
		}

		this.running = true;
		const state = plan.state;
		const report: SyncReport = {
			uploaded: 0,
			downloaded: 0,
			conflicts: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			skipped: 0,
			errors: [],
		};

		try {
			const rootId =
				plan.rootId ?? (await this.drive.ensureFolder(this.getFolderName()));
			state.rootFolderId = rootId;
			const ctx: RunContext = { plan, state, rootId, report, progress };

			// Todo lo que no sea "solo anotar" cuenta como trabajo para la barra de progreso.
			const workTotal = plan.actions.filter(
				(a) => a.type !== "record" && a.type !== "forget"
			).length;
			progress?.phase("Sincronizando", workTotal);

			this.refreshStats(ctx);

			const only = <T extends SyncAction["type"]>(type: T): ActionOf<T>[] =>
				plan.actions.filter((a): a is ActionOf<T> => a.type === type);

			// 1. Conflictos: se guardan ambas versiones
			for (const action of only("conflict")) {
				await this.safely(ctx, action.path, () => this.doConflict(ctx, action));
			}
			await this.persist(state);

			// 2. Descargas
			const downloads = only("download");
			for (const dir of new Set(downloads.map((a) => parentDir(a.path)))) {
				await this.ensureLocalFolder(dir);
			}
			await runPool(downloads, CONCURRENCY, (action) =>
				this.safely(ctx, action.path, () => this.doDownload(ctx, action))
			);
			await this.persist(state);

			// 3. Subidas
			const uploads = only("upload");
			for (const dir of new Set(uploads.map((a) => parentDir(a.path)))) {
				await this.drive.ensureFolderPath(dir, rootId);
			}
			await runPool(uploads, CONCURRENCY, (action) =>
				this.safely(ctx, action.path, () => this.doUpload(ctx, action))
			);
			await this.persist(state);

			// 4. Borrados (a la papelera, nunca definitivos)
			for (const action of only("delete-local")) {
				await this.safely(ctx, action.path, () => this.doDeleteLocal(ctx, action));
			}
						for (const action of only("delete-remote")) {
				await this.safely(ctx, action.path, async () => {
					// Seguridad: si el archivo SÍ existe en el disco, no lo borraste:
					// simplemente Obsidian no lo detecta. No tocamos Drive.
					if (await this.app.vault.adapter.exists(action.path)) {
						report.skipped++;
						report.errors.push(
							`${action.path}: existe en el disco pero Obsidian no lo detecta; no se tocó Drive`
						);
						return;
					}
					await this.drive.trashFile(action.remoteId);
					delete state.files[action.path];
					report.deletedRemote++;
				});
			}

			// 5. Solo anotar en el estado
			for (const action of only("record")) {
				const local = plan.local.get(action.path);
				if (!local) continue;
				state.files[action.path] = {
					id: action.remoteId,
					md5: action.md5,
					mtime: local.mtime,
					size: local.size,
				};
			}
			for (const action of only("forget")) {
				delete state.files[action.path];
			}

			return report;
		} finally {
			this.running = false;
			await this.persist(state);
		}
	}

	// Si un archivo falla, lo anotamos y seguimos con los demás.
	// Solo una sesión caducada detiene toda la sincronización.
	private async safely(
		ctx: RunContext,
		path: string,
		work: () => Promise<void>
	): Promise<void> {
		try {
			await work();
		} catch (error) {
			if (error instanceof AuthExpiredError) throw error;
			console.error(`GDrive Sync: error con ${path}`, error);
			const message = error instanceof Error ? error.message : String(error);
			ctx.report.errors.push(`${path}: ${message}`);
		} finally {
			ctx.progress?.advance(path);
		}
	}

	private async persist(state: SyncState): Promise<void> {
		await saveState(this.app.vault.adapter, this.getStatePath(), state);
	}

	// Si un archivo solo cambió de fecha pero no de contenido, actualizamos
	// la fecha recordada para no tener que recalcular su hash cada vez.
	private refreshStats(ctx: RunContext): void {
		for (const [path, entry] of ctx.plan.local) {
			const known = ctx.state.files[path];
			if (
				known &&
				known.md5 === entry.md5 &&
				(known.mtime !== entry.mtime || known.size !== entry.size)
			) {
				known.mtime = entry.mtime;
				known.size = entry.size;
			}
		}
	}

	// ---------- Acciones ----------

	private async doUpload(ctx: RunContext, action: ActionOf<"upload">): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(action.path);
		if (!(file instanceof TFile)) {
			throw new Error("El archivo ya no existe en la bóveda");
		}

		// Importante: anotamos fecha y tamaño ANTES de leer. Si el archivo cambia
		// mientras se sube, la próxima vez se detectará como modificado.
		const { mtime, size } = file.stat;
		const data = await this.app.vault.readBinary(file);
		const md5 = md5Hex(data);
		const mime = mimeFor(action.path);

		let result: DriveFile;
		if (action.remoteId) {
			result = await this.drive.updateFile(action.remoteId, data, mime);
		} else {
			const parentId = await this.drive.ensureFolderPath(
				parentDir(action.path),
				ctx.rootId
			);
			result = await this.drive.uploadFile(baseName(action.path), parentId, data, mime);
		}

		if (result.md5Checksum && result.md5Checksum !== md5) {
			throw new Error("Drive recibió un contenido distinto al enviado");
		}

		ctx.state.files[action.path] = { id: result.id, md5, mtime, size };
		ctx.report.uploaded++;
	}

	private async doDownload(
		ctx: RunContext,
		action: ActionOf<"download">
	): Promise<void> {
		const expected = ctx.plan.remote.get(action.path)?.md5;
		const data = await this.drive.downloadFile(action.remoteId);
		const md5 = md5Hex(data);
		if (expected && md5 !== expected) {
			throw new Error("La descarga no coincide con lo esperado; se reintentará");
		}

		const existing = this.app.vault.getAbstractFileByPath(action.path);
		let file: TFile;

		if (existing instanceof TFile) {
			if (!action.overwrite) {
				throw new Error("Ya existe un archivo con ese nombre; se omite para no pisarlo");
			}
			// Comprobamos que no lo hayas editado mientras sincronizaba
			const planned = ctx.plan.local.get(action.path)?.md5;
			const current = md5Hex(await this.app.vault.readBinary(existing));
			if (planned && current !== planned) {
				throw new Error("El archivo cambió mientras se sincronizaba; se omite");
			}
			await this.app.vault.modifyBinary(existing, data);
			file = existing;
				} else if (existing) {
			throw new Error("Hay una carpeta con ese nombre");
		} else {
			// Si existe en el disco pero Obsidian no lo detecta, no lo pisamos.
			if (await this.app.vault.adapter.exists(action.path)) {
				throw new Error(
					"Existe en el disco pero Obsidian no lo detecta. Activa «Detectar todas las " +
						"extensiones de archivo» en Ajustes → Archivos y enlaces"
				);
			}
			file = await this.app.vault.createBinary(action.path, data);
		}

		ctx.state.files[action.path] = {
			id: action.remoteId,
			md5,
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		ctx.report.downloaded++;
	}

	// Conflicto: tu versión se guarda como copia "(conflicto ...)" y el
	// archivo original pasa a tener la versión de Drive. No se pierde nada.
	private async doConflict(
		ctx: RunContext,
		action: ActionOf<"conflict">
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(action.path);
		if (!(file instanceof TFile)) throw new Error("El archivo local ya no existe");

		const localData = await this.app.vault.readBinary(file);
		const expected = ctx.plan.remote.get(action.path)?.md5;
		const remoteData = await this.drive.downloadFile(action.remoteId);
		const remoteMd5 = md5Hex(remoteData);
		if (expected && remoteMd5 !== expected) {
			throw new Error("La descarga no coincide con lo esperado; se reintentará");
		}

		// 1) Primero guardamos tu versión en una copia
		const copyPath = this.conflictPath(action.path);
		await this.app.vault.createBinary(copyPath, localData);
		// 2) Después el original pasa a la versión de Drive
		await this.app.vault.modifyBinary(file, remoteData);

		ctx.state.files[action.path] = {
			id: action.remoteId,
			md5: remoteMd5,
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		ctx.report.conflicts++;
		// La copia no tiene entrada en el estado: se subirá como archivo nuevo
		// en la siguiente sincronización.
	}

	private async doDeleteLocal(
		ctx: RunContext,
		action: ActionOf<"delete-local">
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(action.path);
		if (!(file instanceof TFile)) {
			delete ctx.state.files[action.path];
			return;
		}

		// Última comprobación: si lo editaste hace un momento, NO se borra.
		const base = ctx.state.files[action.path];
		const current = md5Hex(await this.app.vault.readBinary(file));
		if (base && current !== base.md5) {
			ctx.report.skipped++;
			return;
		}

		// Respeta tu ajuste de Obsidian (papelera del sistema o carpeta .trash)
		await this.app.fileManager.trashFile(file);
		delete ctx.state.files[action.path];
		ctx.report.deletedLocal++;
	}

	// ---------- Carpetas y nombres ----------

	private async ensureLocalFolder(dir: string): Promise<void> {
		if (!dir) return;
		let current = "";
		for (const part of dir.split("/")) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private conflictPath(path: string): string {
		const dir = parentDir(path);
		const name = baseName(path);
		const dot = name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		const when = stamp(new Date());
		const build = (suffix: string) =>
			(dir ? `${dir}/` : "") + `${stem} (conflicto ${when}${suffix})${ext}`;

		let candidate = build("");
		for (let n = 2; this.app.vault.getAbstractFileByPath(candidate); n++) {
			candidate = build(` ${n}`);
		}
		return candidate;
	}
}
import { Notice, normalizePath } from "obsidian";
import { ConfirmModal } from "./confirm-modal";
import type GDriveSyncPlugin from "./main";
import { PlanResult, SyncEngine } from "./sync";
import { MassDeletionError, SyncExecutor, SyncReport } from "./sync-executor";

export type SyncTrigger = "manual" | "auto";

function clock(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Coordina una sincronización completa (analizar + ejecutar) y avisa del resultado.
// Lo usan tanto los comandos manuales como la sincronización automática.
export class SyncRunner {
	statusEl: HTMLElement | null = null;
	lastFinished = 0; // momento (ms) en que terminó la última sincronización

	private busy = false;
	private engine: SyncEngine;
	private executor: SyncExecutor;
	private lastAutoError = "";
	private massDeleteWarned = false;
	private pending = false; // hay cambios locales aún sin sincronizar
	private lastChangeAt = 0;

	constructor(private plugin: GDriveSyncPlugin) {
		const getFolderName = () =>
			plugin.settings.driveFolderName || plugin.app.vault.getName();

		const getStatePath = () => {
			const dir = plugin.manifest.dir;
			if (!dir) throw new Error("No se encontró la carpeta del plugin");
			return normalizePath(`${dir}/sync-state.json`);
		};

		this.engine = new SyncEngine(plugin.app, plugin.drive, getFolderName, getStatePath);
		this.executor = new SyncExecutor(plugin.app, plugin.drive, getFolderName, getStatePath);
	}

	get isBusy(): boolean {
		return this.busy;
	}

	get hasPendingChanges(): boolean {
		return this.pending;
	}

	// Anota que el usuario cambió algo en la bóveda y todavía no se ha sincronizado.
	markChanged(): void {
		this.pending = true;
		this.lastChangeAt = Date.now();
		if (!this.busy) this.setStatus("cambios sin sincronizar");
	}

	setStatus(text: string): void {
		this.statusEl?.setText(`GDrive: ${text}`);
	}

	// Calcula qué haría la sincronización, sin hacer nada.
	async preview(): Promise<PlanResult> {
		return this.engine.buildPlan();
	}

	// Devuelve true si la sincronización terminó bien y sin errores.
	async run(trigger: SyncTrigger): Promise<boolean> {
		if (this.busy) {
			if (trigger === "manual") new Notice("Ya hay una sincronización en curso.");
			return false;
		}
		// La automática se salta en silencio si no hay sesión o no hay internet.
		if (
			trigger === "auto" &&
			(!this.plugin.settings.refreshToken || navigator.onLine === false)
		) {
			return false;
		}

		this.busy = true;
		this.setStatus("sincronizando...");
		const startedAt = Date.now();
		let ok = false;
		try {
			if (trigger === "manual") new Notice("Sincronizando...");
			const plan = await this.engine.buildPlan();
			ok = await this.executePlan(plan, trigger, false);
		} catch (error) {
			this.handleError(error, trigger);
		} finally {
			this.finish(ok, startedAt);
		}
		return ok;
	}

	// Cierra una sincronización: libera el bloqueo y actualiza los "cambios pendientes".
	private finish(ok: boolean, startedAt: number): void {
		this.busy = false;
		this.lastFinished = Date.now();
		// Si no hubo ediciones durante la sincronización, ya no queda nada pendiente.
		if (ok && this.lastChangeAt <= startedAt) this.pending = false;
	}

	private async executePlan(
		plan: PlanResult,
		trigger: SyncTrigger,
		allowMassDelete: boolean
	): Promise<boolean> {
		try {
			const report = await this.executor.execute(plan, { allowMassDelete });
			this.lastAutoError = "";
			this.massDeleteWarned = false;
			this.setStatus(
				report.errors.length > 0
					? `${report.errors.length} con error`
					: `sincronizado ${clock(new Date())}`
			);
			this.showReport(report, trigger);
			return report.errors.length === 0;
		} catch (error) {
			if (!(error instanceof MassDeletionError)) throw error;

			this.setStatus("detenida (muchos borrados)");
			if (trigger === "manual") {
				new ConfirmModal(
					this.plugin.app,
					"¿Borrar muchos archivos?",
					`La sincronización quiere borrar ${error.count} archivos (a la papelera). ` +
						"Si no esperabas esto, cancela y revisa con «Sync: preview changes».",
					"Borrar y continuar",
					() => {
						void this.runConfirmed(plan);
					}
				).open();
			} else if (!this.massDeleteWarned) {
				this.massDeleteWarned = true;
				new Notice(
					`Sincronización automática detenida: quiere borrar ${error.count} archivos. ` +
						"Ejecuta «Sync now» para revisarlo.",
					10000
				);
			}
			return false;
		}
	}

	// Continúa después de que el usuario confirma un borrado masivo.
	private async runConfirmed(plan: PlanResult): Promise<void> {
		if (this.busy) {
			new Notice("Ya hay una sincronización en curso.");
			return;
		}
		this.busy = true;
		this.setStatus("sincronizando...");
		const startedAt = Date.now();
		let ok = false;
		try {
			ok = await this.executePlan(plan, "manual", true);
		} catch (error) {
			this.handleError(error, "manual");
		} finally {
			this.finish(ok, startedAt);
		}
	}

	private handleError(error: unknown, trigger: SyncTrigger): void {
		console.error("GDrive Sync:", error);
		const message = error instanceof Error ? error.message : String(error);
		this.setStatus("error");

		// En automático no repetimos el mismo aviso una y otra vez.
		if (trigger === "manual" || message !== this.lastAutoError) {
			new Notice(message, 8000);
		}
		if (trigger === "auto") this.lastAutoError = message;
	}

	private showReport(report: SyncReport, trigger: SyncTrigger): void {
		const done =
			report.uploaded +
			report.downloaded +
			report.conflicts +
			report.deletedLocal +
			report.deletedRemote;
		const nothing = done === 0 && report.errors.length === 0 && report.skipped === 0;

		// La automática no molesta si no hubo nada que hacer.
		if (nothing && trigger === "auto") return;

		const lines: string[] = [];
		if (nothing) {
			lines.push("Todo estaba al día.");
		} else {
			lines.push("Sincronización terminada.");
			lines.push(
				`↑ ${report.uploaded} · ↓ ${report.downloaded} · conflictos ${report.conflicts}`
			);
			lines.push(
				`Borrados aquí ${report.deletedLocal} · en Drive ${report.deletedRemote}` +
					(report.skipped > 0 ? ` · omitidos ${report.skipped}` : "")
			);
		}
		if (report.errors.length > 0) {
			lines.push(`⚠ ${report.errors.length} con error (detalle en la consola):`);
			lines.push(...report.errors.slice(0, 3));
		}
		new Notice(lines.join("\n"), 10000);
	}
}
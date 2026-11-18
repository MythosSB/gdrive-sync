import { Notice, normalizePath } from "obsidian";
import { ConfirmModal } from "./confirm-modal";
import type GDriveSyncPlugin from "./main";
import { PlanModal } from "./plan-modal";
import { PlanResult, SyncEngine } from "./sync";
import { MassDeletionError, SyncExecutor, SyncReport } from "./sync-executor";

// Registra los comandos relacionados con la sincronización.
export function registerSyncCommands(plugin: GDriveSyncPlugin): void {
	const getFolderName = () =>
		plugin.settings.driveFolderName || plugin.app.vault.getName();

	const getStatePath = () => {
		const dir = plugin.manifest.dir;
		if (!dir) throw new Error("No se encontró la carpeta del plugin");
		return normalizePath(`${dir}/sync-state.json`);
	};

	const engine = new SyncEngine(plugin.app, plugin.drive, getFolderName, getStatePath);
	const executor = new SyncExecutor(plugin.app, plugin.drive, getFolderName, getStatePath);

	const describeError = (error: unknown): string =>
		error instanceof Error ? error.message : String(error);

	const showReport = (report: SyncReport): void => {
		const done =
			report.uploaded +
			report.downloaded +
			report.conflicts +
			report.deletedLocal +
			report.deletedRemote;

		const lines: string[] = [];
		if (done === 0 && report.errors.length === 0 && report.skipped === 0) {
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
	};

	const runPlan = async (plan: PlanResult, allowMassDelete: boolean): Promise<void> => {
		try {
			showReport(await executor.execute(plan, { allowMassDelete }));
		} catch (error) {
			if (error instanceof MassDeletionError) {
				new ConfirmModal(
					plugin.app,
					"¿Borrar muchos archivos?",
					`La sincronización quiere borrar ${error.count} archivos (a la papelera). ` +
						"Si no esperabas esto, cancela y revisa con «Sync: preview changes».",
					"Borrar y continuar",
					() => {
						void runPlan(plan, true);
					}
				).open();
				return;
			}
			console.error(error);
			new Notice(describeError(error));
		}
	};

	const syncNow = async (): Promise<void> => {
		try {
			new Notice("Sincronizando...");
			const plan = await engine.buildPlan();
			await runPlan(plan, false);
		} catch (error) {
			console.error(error);
			new Notice(describeError(error));
		}
	};

	plugin.addCommand({
		id: "sync-dry-run",
		name: "Sync: preview changes (dry run)",
		callback: async () => {
			try {
				new Notice("Analizando cambios...");
				const plan = await engine.buildPlan();
				new PlanModal(plugin.app, plan).open();
			} catch (error) {
				console.error(error);
				new Notice(describeError(error));
			}
		},
	});

	plugin.addCommand({
		id: "sync-now",
		name: "Sync now",
		callback: syncNow,
	});

	plugin.addRibbonIcon("refresh-cw", "GDrive Sync: sync now", () => {
		void syncNow();
	});
}
import type GDriveSyncPlugin from "./main";
import type { SyncRunner } from "./sync-runner";

const OPEN_DELAY_MS = 3000; // espera tras abrir Obsidian antes de sincronizar
const RESUME_MIN_GAP_MS = 2 * 60 * 1000; // mínimo entre sincronizaciones al "volver a la app"
const QUIET_AFTER_SYNC_MS = 3000; // ignora cambios justo después de sincronizar
const RETRY_WHEN_BUSY_MS = 10 * 1000;

// Decide CUÁNDO se sincroniza automáticamente.
export class SyncScheduler {
	private intervalId: number | null = null;
	private changeTimer: number | null = null;
	private openTimer: number | null = null;
	private lastAttempt = 0;

	constructor(private plugin: GDriveSyncPlugin, private runner: SyncRunner) {}

	start(): void {
		const { app } = this.plugin;

		// Al desactivar el plugin, se cancelan todos los temporizadores.
		this.plugin.register(() => this.stop());

		// Volver a la app (importante en el móvil, donde Android la suspende).
		this.plugin.registerDomEvent(document, "visibilitychange", () => {
			if (
				document.visibilityState === "visible" &&
				this.plugin.settings.syncOnOpen &&
				Date.now() - this.lastAttempt > RESUME_MIN_GAP_MS
			) {
				this.trigger();
			}
		});

		app.workspace.onLayoutReady(() => {
			// Sincronizar al abrir
			if (this.plugin.settings.syncOnOpen) {
				this.openTimer = window.setTimeout(() => this.trigger(), OPEN_DELAY_MS);
			}

			// Los eventos de la bóveda se registran DESPUÉS de que termine de cargar;
			// si no, Obsidian dispara un "create" por cada archivo al arrancar.
			const onChange = () => this.onVaultChange();
			this.plugin.registerEvent(app.vault.on("modify", onChange));
			this.plugin.registerEvent(app.vault.on("create", onChange));
			this.plugin.registerEvent(app.vault.on("delete", onChange));
			this.plugin.registerEvent(app.vault.on("rename", onChange));
		});

		this.reconfigure();
	}

	// Se llama al iniciar y cada vez que cambias los ajustes.
	reconfigure(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		const minutes = this.plugin.settings.syncIntervalMinutes;
		if (minutes > 0) {
			this.intervalId = window.setInterval(() => this.trigger(), minutes * 60 * 1000);
			this.plugin.registerInterval(this.intervalId);
		}

		if (!this.plugin.settings.syncOnChange && this.changeTimer !== null) {
			window.clearTimeout(this.changeTimer);
			this.changeTimer = null;
		}
	}

	stop(): void {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
		if (this.openTimer !== null) window.clearTimeout(this.openTimer);
		this.intervalId = this.changeTimer = this.openTimer = null;
	}

	private trigger(): void {
		this.lastAttempt = Date.now();
		void this.runner.run("auto");
	}

	// Cada edición reinicia una cuenta atrás; se sincroniza cuando dejas de editar.
	private onVaultChange(): void {
		if (!this.plugin.settings.syncOnChange) return;

		// Ignoramos los cambios que provoca la propia sincronización.
		if (
			this.runner.isBusy ||
			Date.now() - this.runner.lastFinished < QUIET_AFTER_SYNC_MS
		) {
			return;
		}
		this.scheduleChangeSync(this.plugin.settings.syncOnChangeDelaySeconds * 1000);
	}

	private scheduleChangeSync(delayMs: number): void {
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
		this.changeTimer = window.setTimeout(() => {
			this.changeTimer = null;
			if (this.runner.isBusy) {
				this.scheduleChangeSync(RETRY_WHEN_BUSY_MS); // reintenta en unos segundos
				return;
			}
			this.trigger();
		}, delayMs);
	}
}
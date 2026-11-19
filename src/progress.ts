import { Notice } from "obsidian";
import type { SyncTrigger } from "./sync-runner";

const MIN_RENDER_GAP_MS = 120; // no redibujar más de ~8 veces por segundo
const AUTO_MIN_TOTAL = 5; // en automático, solo mostramos el aviso si hay bastante trabajo
const DETAIL_MAX_CHARS = 60;

// Muestra el avance de la sincronización: un aviso con barra de progreso
// (también en el móvil) y el texto de la barra de estado (escritorio).
export class SyncProgress {
	private notice: Notice | null = null;
	private titleEl: HTMLElement | null = null;
	private barEl: HTMLProgressElement | null = null;
	private detailEl: HTMLElement | null = null;

	private label = "";
	private total = 0;
	private done = 0;
	private detail = "";
	private lastRender = 0;

	constructor(
		private enabled: boolean, // ajuste "Show progress"
		private trigger: SyncTrigger,
		private onStatus: (text: string) => void
	) {}

	// Empieza una fase. total = 0 significa "no sabemos cuánto" (barra indeterminada).
	phase(label: string, total: number): void {
		this.label = label;
		this.total = total;
		this.done = 0;
		this.detail = "";
		this.render(true);
	}

	// Un elemento más terminado.
	advance(detail = ""): void {
		this.done++;
		this.detail = detail;
		this.render(false);
	}

	// Cierra el aviso de progreso.
	finish(): void {
		this.notice?.hide();
		this.notice = null;
		this.titleEl = this.barEl = this.detailEl = null;
	}

	private render(force: boolean): void {
		const now = Date.now();
		const last = this.done >= this.total && this.total > 0;
		if (!force && !last && now - this.lastRender < MIN_RENDER_GAP_MS) return;
		this.lastRender = now;

		const counter = this.total > 0 ? ` ${this.done}/${this.total}` : "";
		const percent = this.total > 0 ? Math.round((this.done / this.total) * 100) : 0;

		// Barra de estado (solo escritorio)
		this.onStatus(
			this.total > 0 ? `${this.label}${counter} (${percent}%)` : `${this.label}...`
		);

		if (!this.shouldShowNotice()) return;
		this.ensureNotice();

		this.titleEl?.setText(
			this.total > 0 ? `${this.label} · ${this.done}/${this.total}` : `${this.label}...`
		);
		if (this.barEl) {
			if (this.total > 0) {
				this.barEl.max = this.total;
				this.barEl.value = this.done;
			} else {
				this.barEl.removeAttribute("value"); // barra indeterminada
			}
		}
		const shown =
			this.detail.length > DETAIL_MAX_CHARS
				? "…" + this.detail.slice(-DETAIL_MAX_CHARS)
				: this.detail;
		this.detailEl?.setText(shown);
	}

	private shouldShowNotice(): boolean {
		if (!this.enabled) return false;
		return this.trigger === "manual" || this.total >= AUTO_MIN_TOTAL;
	}

	private ensureNotice(): void {
		if (this.notice) return;

		// Se construye con un fragmento para no depender de APIs recientes de Obsidian.
		const fragment = createFragment();
		const box = fragment.createDiv({ cls: "gdrive-sync-progress" });
		this.titleEl = box.createDiv({ cls: "gdrive-sync-progress-title" });
		this.barEl = box.createEl("progress");
		this.detailEl = box.createDiv({ cls: "gdrive-sync-progress-detail" });

		this.notice = new Notice(fragment, 0); // 0 = se queda hasta que lo cerremos
	}
}

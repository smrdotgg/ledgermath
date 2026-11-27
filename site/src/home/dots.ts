// Dot art on the grid of the font. One cell is one pixel of Geist Pixel (.038em of the text
// beside it). x counts right from the art's left edge; y counts up from 0, the row that sits on the
// baseline, and rows 0 to 18 are the height of a capital letter. `path()` gives the cells as SVG
// path data for a stroke dashed "0 1" with round ends, which draws one dot for every unit of length
// (see .art in site.css): the way the daisies and the church are drawn on smr.gg. The same path,
// stroked without dashes, draws the cells as squares that touch, as the light scheme's font does.

export class Dots {
	/** The cells that are drawn: each row's columns. */
	private rows = new Map<number, Set<number>>();

	dot(x: number, y: number): this {
		let row = this.rows.get(y);
		if (!row) this.rows.set(y, (row = new Set()));
		row.add(x);
		return this;
	}

	/** A box of dots: w wide and h tall, its lowest row y, its first column x. */
	fill(x: number, y: number, w: number, h: number): this {
		for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j);
		return this;
	}

	/** The same dots, moved dx columns to the right. */
	moved(dx: number): Dots {
		const to = new Dots();
		for (const [y, row] of this.rows) for (const x of row) to.dot(x + dx, y);
		return to;
	}

	/**
	 * The dots as path data: for each row, top to bottom, its runs of neighbouring dots. A run of n
	 * dots from column x in row y is "M x -(y + .5) h n"; the minus sign also separates the numbers.
	 */
	path(): string {
		let d = "";
		for (const y of [...this.rows.keys()].sort((a, b) => b - a)) {
			if (y < 0) throw new Error("a dot below the baseline: the path's numbers would run together");
			const columns = [...this.rows.get(y)!].sort((a, b) => a - b);
			let start = columns[0]!;
			let end = start;
			for (const x of columns.slice(1)) {
				if (x !== end + 1) {
					d += `M${start}${-(y + 0.5)}h${end - start + 1}`;
					start = x;
				}
				end = x;
			}
			d += `M${start}${-(y + 0.5)}h${end - start + 1}`;
		}
		return d;
	}
}

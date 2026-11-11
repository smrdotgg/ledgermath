/**
 * Where a -runs stage launches its box. infra/runs/stack.ts launches here, and
 * scripts/alarm.ts watches the Series of schedule.json here, so the two cannot
 * drift apart. Step 4 of the plan (#36) turns PLACEMENTS into a longer list.
 *
 * Plain data: no SST global is used, so tests and scripts can import it.
 */

export interface Placement {
	/** An EC2 instance type, in AWS's words. */
	instanceType: string;
	/** An availability zone name, such as us-east-2c: the zone whose default subnet the box is launched in. */
	zone: string;
}

/** The one placement the stage launches today. */
export const PLACEMENT: Placement = { instanceType: "c6i.8xlarge", zone: "us-east-2c" };

/** Every placement whose Series the alarm watches. */
export const PLACEMENTS: readonly Placement[] = [PLACEMENT];

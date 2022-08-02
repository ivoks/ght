import { Page } from "puppeteer";
import { MAIN_URL } from "../common/constants";
import UserError from "../common/UserError";
import { Application, Grader } from "./types";

/**
 * Interact with Greenhouse UI and assign
 * graders to written inteviews
 */
export default class LoadBalancer {
    private page: Page;
    private graders: Grader[];
    private jobs: string[];

    constructor(page: Page, graders: Grader[], selectedJobs: string[]) {
        this.page = page;
        this.graders = graders;
        this.jobs = selectedJobs;
    }

    /**
     * Return applications in current page
     */
    private async getApplicationsPage() {
        return await this.page.$$eval(".person", (people) =>
            people.map((p) => {
                const applicationID = p.getAttribute("application");
                const toggleText = p.querySelector(
                    "a.toggle-interviews"
                )?.textContent;
                const toGrade = toggleText?.includes("Scorecard due");
                const job = p
                    .querySelector(".job")
                    // Delete requisition ID next to job name
                    ?.textContent?.replace(/\(\d+\)/, "")
                    .trim();
                const candidate = p.querySelector(".name a")?.textContent;

                if (
                    applicationID != null &&
                    candidate != null &&
                    job != null &&
                    toGrade != null
                ) {
                    return {
                        applicationID,
                        candidate,
                        job,
                        toGrade,
                    };
                }
            })
        );
    }

    /**
     * Get applications to process one at a time
     */
    private async *getApplicationsToProcess() {
        while (true) {
            await this.page.waitForSelector(".person");
            const applicationsPage = await this.getApplicationsPage();

            for (const application of applicationsPage) {
                if (
                    application &&
                    application?.toGrade &&
                    this.jobs.includes(application.job)
                ) {
                    yield application;
                }
            }

            // Keep doing this until there are no more pages
            const nextPageBtn = await this.page.$("a.next_page:not(.disabled)");
            if (!nextPageBtn) return;

            await Promise.all([
                this.page.waitForNavigation(),
                nextPageBtn.click(),
            ]);
        }
    }

    /**
     * Get random grader from array
     */
    private getRandom(graders: Grader[]) {
        return graders[Math.floor(Math.random() * graders.length)];
    }

    /**
     * Type grader's name
     */
    private async writeGrader(grader: Grader) {
        await this.page.type(".search-field input[type='text']", grader.name);
        await this.page.keyboard.press("Enter");
    }

    /**
     * Find two random graders for an application
     */
    private findRandomGraders(application: Application) {
        const graders = this.graders.filter(
            (grader: Grader) => grader.job == application.job
        );
        if (graders.length < 2) {
            throw new UserError("Not enough graders to pick from");
        }
        const grader1 = this.getRandom(graders);
        // Remove first grader so it doesn't get choosen twice
        const grader2 = this.getRandom(
            graders.filter((name) => name !== grader1)
        );

        return [grader1, grader2];
    }

    /**
     * Find current user name in UI
     */
    private async findUsername() {
        return await this.page.$eval(
            "script[data-user-name]",
            (el) => (el as HTMLElement).dataset.userName
        );
    }

    public async execute(): Promise<void> {
        await this.page.goto(
            `${MAIN_URL}people?sort_by=last_activity&sort_order=desc&stage_status_id%5B%5D=2&in_stages%5B%5D=Written+Interview`
        );

        const currentUser = await this.findUsername();
        if (!currentUser) {
            throw new Error("Unable to find user's name in Greenhouse");
        }

        for await (const application of this.getApplicationsToProcess()) {
            console.log(application);
            const selector = `.person[application="${application?.applicationID}"]`;

            // Click toggle button
            await this.page.waitForSelector(`${selector} .toggle-interviews`);
            await this.page?.click(`${selector} .toggle-interviews`);

            // Click edit
            await this.page.waitForSelector(
                `${selector} .edit-take-home-test-graders-link`
            );
            await this.page.click(
                `${selector} .edit-take-home-test-graders-link`
            );

            // Wait for modal to open
            await this.page.waitForSelector(
                "[aria-describedby='edit_take_home_test_graders_modal']"
            );

            // Read graders already assigned
            const gradersAssigned = await this.page.$$eval(
                "ul .search-choice span",
                (el) => el.map((grader) => grader.textContent)
            );
            // Skip if already two graders assigned
            if (gradersAssigned.length >= 2) {
                continue;
            }

            // Click input field
            await this.page.waitForSelector(".search-field input[type='text']");
            await this.page.click(".search-field input[type='text']");

            // If there's only one grader and is the user running the command remove it
            // (hiring leads are assigned by default as graders)
            if (
                gradersAssigned.length === 1 &&
                gradersAssigned[0] === currentUser
            ) {
                await this.page.keyboard.press("Backspace");
                await this.page.keyboard.press("Backspace");
            }

            const [grader1, grader2] = this.findRandomGraders(application);
            await this.writeGrader(grader1);
            await this.writeGrader(grader2);

            console.log(
                `Written Interview from ${application.candidate} assigned to: ${grader1.name}, ${grader2.name}`
            );

            // Click save
            await this.page.click("input[type='submit']");
        }
    }
}

import { describe, expect, it } from "vitest";

import { boardPostingUrl, postingUrl } from "../electron/postings.js";

describe("postingUrl", () => {
  it("canonicalizes LinkedIn postings and search pages", () => {
    const canon = "https://www.linkedin.com/jobs/view/4486579587/";
    expect(postingUrl("https://www.linkedin.com/jobs/view/4486579587/?trk=abc&refId=x")).toBe(canon);
    expect(postingUrl("https://linkedin.com/jobs/view/4486579587")).toBe(canon);
    expect(postingUrl("https://www.linkedin.com/jobs/search/?currentJobId=4486579587&keywords=eng")).toBe(canon);
  });

  it("canonicalizes Indeed postings on any country host", () => {
    expect(postingUrl("https://www.indeed.com/viewjob?jk=0a1b2c&from=serp&tk=1")).toBe("https://www.indeed.com/viewjob?jk=0a1b2c");
    expect(postingUrl("https://www.indeed.com/rc/clk?jk=0a1b2c&fccid=x")).toBe("https://www.indeed.com/viewjob?jk=0a1b2c");
    expect(postingUrl("https://uk.indeed.com/jobs?q=eng&vjk=0a1b2c")).toBe("https://uk.indeed.com/viewjob?jk=0a1b2c");
  });

  it("keeps anything else as captured, trimmed", () => {
    expect(postingUrl(" https://careers.acme.com/jobs/1?src=x ")).toBe("https://careers.acme.com/jobs/1?src=x");
    expect(postingUrl("https://www.indeed.com/companies")).toBe("https://www.indeed.com/companies");
    expect(postingUrl("not a url")).toBe("not a url");
    expect(postingUrl(undefined)).toBe("");
  });

  it("boardPostingUrl is null off known boards", () => {
    expect(boardPostingUrl("https://careers.acme.com/jobs/1")).toBeNull();
    expect(boardPostingUrl("https://www.linkedin.com/feed/")).toBeNull();
    expect(boardPostingUrl(null)).toBeNull();
  });
});

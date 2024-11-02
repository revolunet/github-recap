#!/usr/bin/env yarn -s ts-node

// Interfaces
interface GitHubCommit {
  sha: string;
  date: string;
  message: string;
  url: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  url: string;
  body: string;
}

interface RepositoryContributions {
  commits: GitHubCommit[];
  releases: GitHubRelease[];
}

interface ContributionsMetadata {
  date_range: {
    from: string;
    to: string;
  };
  total_commits: number;
  total_releases: number;
  repositories_count: number;
}

export interface ContributionsResponse {
  metadata: ContributionsMetadata;
  repositories: Record<string, RepositoryContributions>;
}

class GitHubContributionsCollector {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly cutoffDate: Date;

  constructor(token: string, days: number = 30) {
    this.token = token;
    this.baseUrl = "https://api.github.com";
    this.headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    this.cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  private async makeRequest<T>(
    url: string,
    params: Record<string, any> = {},
    customHeaders: Record<string, string> = {}
  ): Promise<T> {
    try {
      const queryString = new URLSearchParams(params).toString();
      const response = await fetch(`${url}?${queryString}`, {
        headers: { ...this.headers, ...customHeaders },
        //body: JSON.stringify(params),
      });
      return response.json();
    } catch (error: any) {
      // if (axios.isAxiosError(error)) {
      console.error(`Request failed: ${error.message}`);
      console.error("Response:", error.response?.data);
      //}
      throw error;
    }
  }

  async getUserRecentCommits(username: string): Promise<Set<string>> {
    const repos = new Set<string>();
    let page = 1;

    while (true) {
      const searchResponse = await this.makeRequest<{
        items: Array<{ repository: { full_name: string } }>;
        total_count: number;
      }>(
        `${this.baseUrl}/search/commits`,
        {
          q: `author:${username} author-date:>${
            this.cutoffDate.toISOString().split("T")[0]
          }`,
          sort: "author-date",
          order: "desc",
          page,
          per_page: 100,
        },
        { Accept: "application/vnd.github.cloak-preview+json" }
      );

      if (!searchResponse.items.length) break;

      searchResponse.items.forEach((item) => {
        repos.add(item.repository.full_name);
      });

      if (page * 100 >= searchResponse.total_count) break;
      page++;
    }

    return repos;
  }

  private getRepoOwner(repoFullName: string): string {
    return repoFullName.split("/")[0];
  }

  async getUserCommits(
    repo: string,
    username: string
  ): Promise<GitHubCommit[]> {
    const commits: GitHubCommit[] = [];
    let page = 1;

    while (true) {
      try {
        const response = await this.makeRequest<
          Array<{
            sha: string;
            commit: { author: { date: string }; message: string };
            html_url: string;
          }>
        >(`${this.baseUrl}/repos/${repo}/commits`, {
          author: username,
          since: this.cutoffDate.toISOString(),
          page,
          per_page: 100,
        });

        if (!response.length) break;

        commits.push(
          ...response.map((commit) => ({
            sha: commit.sha,
            date: commit.commit.author.date,
            message: commit.commit.message,
            url: commit.html_url,
          }))
        );

        page++;
      } catch (error) {
        console.warn(`Failed to fetch commits for ${repo}`);
        break;
      }
    }

    return commits;
  }

  async getReleases(repo: string): Promise<GitHubRelease[]> {
    const releases: GitHubRelease[] = [];
    let page = 1;

    while (true) {
      try {
        const response = await this.makeRequest<
          Array<{
            tag_name: string;
            name: string;
            published_at: string;
            html_url: string;
            body: string;
          }>
        >(`${this.baseUrl}/repos/${repo}/releases`, {
          page,
          per_page: 100,
        });

        if (!response.length) break;

        const recentReleases = response.filter(
          (release) => new Date(release.published_at) > this.cutoffDate
        );

        if (
          !recentReleases.length &&
          new Date(response[response.length - 1].published_at) < this.cutoffDate
        ) {
          break;
        }

        releases.push(
          ...recentReleases.map((release) => ({
            tag_name: release.tag_name,
            name: release.name,
            published_at: release.published_at,
            url: release.html_url,
            body: release.body,
          }))
        );

        page++;
      } catch (error) {
        console.warn(`Failed to fetch releases for ${repo}`);
        break;
      }
    }

    return releases;
  }

  async collectContributions(username: string): Promise<ContributionsResponse> {
    // Get all repositories where user has recently committed
    const recentRepos = await this.getUserRecentCommits(username);

    const reposToAnalyze = Array.from(recentRepos);

    // Collect detailed information for each repository
    const repositories: Record<string, RepositoryContributions> = {};
    let totalCommits = 0;
    let totalReleases = 0;

    for (const repo of reposToAnalyze) {
      const [commits, releases] = await Promise.all([
        this.getUserCommits(repo, username),
        this.getReleases(repo),
      ]);

      if (commits.length || releases.length) {
        repositories[repo] = { commits, releases };
        totalCommits += commits.length;
        totalReleases += releases.length;
      }
    }

    return {
      metadata: {
        date_range: {
          from: this.cutoffDate.toISOString(),
          to: new Date().toISOString(),
        },
        total_commits: totalCommits,
        total_releases: totalReleases,
        repositories_count: Object.keys(repositories).length,
      },
      repositories,
    };
  }
}

async function main() {
  // Get GitHub token from environment variable
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Please set GITHUB_TOKEN environment variable");
  }

  // Get command line arguments or use defaults
  const username =
    process.argv[2] || (await question("Enter GitHub username: "));
  const days = parseInt(
    process.argv[3] ||
      (await question("Enter number of days to look back (default 30): ")) ||
      "30"
  );

  // Initialize collector and get contributions
  const collector = new GitHubContributionsCollector(token, days);
  const contributions = await collector.collectContributions(username);

  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const report = makeMarkdownReport({
    intro: `# GitHub report
    
[${username}](https://github.com/${username}) from ${start.toDateString()} to ${now.toDateString()}`,
    contributions,
  });

  console.log(report);
}

const makeMarkdownReport = ({
  intro,
  contributions,
}: {
  intro: string;
  contributions: ContributionsResponse;
}) => {
  return `
${intro}

${Object.entries(contributions.repositories)
  .map(
    ([key, contrib]) => `## [${key}](https://github.com/${key})

### Commits

${contrib.commits
  .map(
    (commit) =>
      ` - ${commit.message.replace("\n", " ")} [${commit.sha}](${commit.url})`
  )
  .join("\n")}

${
  contrib.releases.length
    ? `### Releases

${contrib.releases
  .map((release) => ` - ${release.name} [${release.tag_name}](${release.url})`)
  .join("\n")}`
    : ""
}
`
  )
  .join("\n")}
    `;
};
// Helper function for CLI input
function question(query: string): Promise<string> {
  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    readline.question(query, (answer: string) => {
      readline.close();
      resolve(answer.trim());
    })
  );
}

// Run the script if called directly
if (require.main === module) {
  main().catch(console.error);
}

export { GitHubContributionsCollector };

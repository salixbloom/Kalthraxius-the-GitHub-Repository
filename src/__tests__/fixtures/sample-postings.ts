import type { RawJob } from '../../types.js'

/**
 * Hand-built sample postings approximating real listings across 3 platforms
 * (greenhouse, lever, linkedin), used for Phase 4 verification gates:
 *   - salary null rate <10% on postings that visibly contain a range
 *   - seniority accuracy >90% on postings with an explicit title signal
 *   - skills recall on explicit skills sections
 *
 * `expect` carries the ground truth we assert against. A field is `undefined`
 * in `expect` when that posting genuinely has no signal for it (so the test
 * can separate "should be null" from "should be extracted").
 */
export interface SamplePosting {
  job: RawJob
  expect: {
    /** True if the posting visibly contains a salary range/figure. */
    hasVisibleSalary: boolean
    seniority?: string
    /** Skill ids that appear explicitly and should be recalled. */
    skills?: string[]
  }
}

let counter = 0
function job(p: Partial<RawJob>): RawJob {
  counter++
  return {
    contentHash: `fixture-${counter}`,
    platformId: p.platformId ?? 'greenhouse-acme',
    url: p.url ?? `https://example.com/jobs/${counter}`,
    title: p.title ?? 'Engineer',
    company: p.company ?? 'Acme',
    location: p.location ?? 'Remote',
    description: p.description ?? '',
    salary: p.salary ?? null,
    postedAt: p.postedAt ?? '2026-05-01',
    scrapedAt: Date.now(),
  }
}

export const SAMPLE_POSTINGS: SamplePosting[] = [
  // ---- greenhouse ----
  {
    job: job({
      platformId: 'greenhouse-acme',
      title: 'Senior Backend Engineer',
      salary: '$160,000 - $190,000',
      description: `Required skills:
        - Python
        - Django
        - PostgreSQL
        - Redis
        - Docker
        5+ years of experience building web services.`,
    }),
    expect: { hasVisibleSalary: true, seniority: 'senior', skills: ['python', 'django', 'postgresql', 'redis', 'docker'] },
  },
  {
    job: job({
      platformId: 'greenhouse-acme',
      title: 'Staff Software Engineer',
      salary: '$210k–$250k',
      description: 'Work on distributed systems in Go and Kubernetes. 8+ years of experience.',
    }),
    expect: { hasVisibleSalary: true, seniority: 'staff', skills: ['go', 'kubernetes'] },
  },
  {
    job: job({
      platformId: 'greenhouse-acme',
      title: 'Junior Frontend Developer',
      salary: null,
      description: 'Entry-level role. You will work with React, TypeScript, and CSS.',
    }),
    expect: { hasVisibleSalary: false, seniority: 'junior', skills: ['react', 'typescript', 'css'] },
  },

  // ---- lever ----
  {
    job: job({
      platformId: 'lever-globex',
      title: 'Principal Data Engineer',
      salary: 'Compensation: $180,000 to $220,000 per year',
      description: 'Build pipelines with Apache Spark, Airflow, and Snowflake. At least 10 years experience.',
    }),
    expect: { hasVisibleSalary: true, seniority: 'principal', skills: ['spark', 'airflow', 'snowflake'] },
  },
  {
    job: job({
      platformId: 'lever-globex',
      title: 'Engineering Manager',
      salary: '$200k - $240k',
      description: 'Lead a team of engineers. Background in Java and AWS. 6+ years experience.',
    }),
    expect: { hasVisibleSalary: true, seniority: 'manager', skills: ['java', 'aws'] },
  },
  {
    job: job({
      platformId: 'lever-globex',
      title: 'DevOps Engineer',
      salary: '£70,000 - £90,000',
      description: 'Terraform, Ansible, Kubernetes, and CI/CD pipelines. Prometheus and Grafana for monitoring.',
    }),
    expect: { hasVisibleSalary: true, skills: ['terraform', 'ansible', 'kubernetes', 'ci-cd', 'prometheus', 'grafana'] },
  },

  // ---- linkedin ----
  {
    job: job({
      platformId: 'linkedin',
      title: 'Senior Machine Learning Engineer',
      salary: '$170,000–$210,000',
      description: 'Deep learning with PyTorch and TensorFlow. NLP experience a plus. 5+ years of experience.',
    }),
    expect: { hasVisibleSalary: true, seniority: 'senior', skills: ['pytorch', 'tensorflow', 'nlp', 'machine-learning'] },
  },
  {
    job: job({
      platformId: 'linkedin',
      title: 'Full Stack Developer',
      salary: '$120/hr',
      description: 'Contract role. Node.js, React, MongoDB, and GraphQL. 3-5 years experience.',
    }),
    expect: { hasVisibleSalary: true, skills: ['nodejs', 'react', 'mongodb', 'graphql'] },
  },
  {
    job: job({
      platformId: 'linkedin',
      title: 'Director of Engineering',
      salary: '$260,000 - $320,000',
      description: 'Lead multiple engineering teams. Strategic technical leadership.',
    }),
    expect: { hasVisibleSalary: true, seniority: 'director' },
  },
  {
    job: job({
      platformId: 'linkedin',
      title: 'Software Engineering Intern',
      salary: null,
      description: 'Summer internship. Currently enrolled in a CS program. Python or Java.',
    }),
    expect: { hasVisibleSalary: false, seniority: 'intern', skills: ['python', 'java'] },
  },
]

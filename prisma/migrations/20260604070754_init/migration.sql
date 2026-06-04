-- CreateTable
CREATE TABLE "members" (
    "member_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "dob" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "policies" (
    "policy_id" TEXT NOT NULL PRIMARY KEY,
    "member_id" TEXT NOT NULL,
    "effective_date" TEXT NOT NULL,
    "termination_date" TEXT NOT NULL,
    "plan_year" INTEGER NOT NULL,
    "annual_deductible_minor" INTEGER NOT NULL,
    "exclusions" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "policies_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members" ("member_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "coverage_rules" (
    "policy_id" TEXT NOT NULL,
    "service_category" TEXT NOT NULL,
    "covered" BOOLEAN NOT NULL,
    "annual_limit_minor" INTEGER,
    "visit_limit" INTEGER,
    "per_incident_max_minor" INTEGER,
    "coinsurance_rate" REAL,
    "copay_minor" INTEGER,
    "review_threshold_minor" INTEGER,

    PRIMARY KEY ("policy_id", "service_category"),
    CONSTRAINT "coverage_rules_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies" ("policy_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "claims" (
    "claim_id" TEXT NOT NULL PRIMARY KEY,
    "member_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "date_of_service" TEXT NOT NULL,
    "submitted_at" DATETIME NOT NULL,
    "state" TEXT NOT NULL,
    CONSTRAINT "claims_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members" ("member_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "claims_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies" ("policy_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "claim_lines" (
    "line_id" TEXT NOT NULL PRIMARY KEY,
    "claim_id" TEXT NOT NULL,
    "service_code" TEXT NOT NULL,
    "service_category" TEXT NOT NULL,
    "diagnosis_code" TEXT NOT NULL,
    "billed_minor" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    CONSTRAINT "claim_lines_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims" ("claim_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "adjudications" (
    "adjudication_id" TEXT NOT NULL PRIMARY KEY,
    "line_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "is_current" BOOLEAN NOT NULL,
    "decision_code" TEXT NOT NULL,
    "reason_codes" TEXT NOT NULL,
    "allowed_minor" INTEGER NOT NULL,
    "deductible_applied_minor" INTEGER NOT NULL,
    "coinsurance_minor" INTEGER NOT NULL,
    "copay_minor" INTEGER NOT NULL,
    "payable_minor" INTEGER NOT NULL,
    "member_resp_minor" INTEGER NOT NULL,
    "adjudicated_at" DATETIME NOT NULL,
    CONSTRAINT "adjudications_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "claim_lines" ("line_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "usage_ledger_entries" (
    "entry_id" TEXT NOT NULL PRIMARY KEY,
    "member_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "amount_or_count" INTEGER NOT NULL,
    "source_line_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL,
    CONSTRAINT "usage_ledger_entries_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members" ("member_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "usage_ledger_entries_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies" ("policy_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "usage_ledger_entries_source_line_id_fkey" FOREIGN KEY ("source_line_id") REFERENCES "claim_lines" ("line_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "disputes" (
    "dispute_id" TEXT NOT NULL PRIMARY KEY,
    "claim_id" TEXT NOT NULL,
    "line_ids" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "resolution_outcome" TEXT,
    "resolution_note" TEXT,
    "opened_at" DATETIME NOT NULL,
    "resolved_at" DATETIME,
    CONSTRAINT "disputes_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims" ("claim_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "explanation_codes" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "short_message" TEXT NOT NULL,
    "detail_template" TEXT NOT NULL,
    "category" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "adjudications_line_id_is_current_idx" ON "adjudications"("line_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "adjudications_line_id_sequence_key" ON "adjudications"("line_id", "sequence");

-- CreateIndex
CREATE INDEX "usage_ledger_entries_member_id_period_bucket_idx" ON "usage_ledger_entries"("member_id", "period", "bucket");

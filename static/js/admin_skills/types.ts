export interface AdminUser {
    id?: number | string;
    username?: string;
    full_name?: string;
    is_admin?: boolean;
    phones?: string[];
}

export interface SkillSummary {
    name: string;
    description?: string;
    generated?: boolean;
    disabled?: boolean;
}

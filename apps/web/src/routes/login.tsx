import { createFileRoute } from '@tanstack/react-router';
import { AuthForm } from '../account/AuthForm';

export const Route = createFileRoute('/login')({ component: () => <AuthForm mode="login" /> });

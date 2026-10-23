import type { ComponentProps } from 'react';
import { CardTitle as KitCardTitle } from '../components/ui/card.tsx';

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from '../components/ui/card.tsx';

export function CardTitle({ children, ...props }: ComponentProps<'h3'>) {
  return (
    <h3 {...props}>
      <KitCardTitle>{children}</KitCardTitle>
    </h3>
  );
}

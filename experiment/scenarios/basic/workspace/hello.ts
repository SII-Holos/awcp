/**
 * Hello module - Basic greeting functions
 */

export function sayHello(name: string): string {
  return `Hello, ${name}!`;
}

export function sayGoodbye(name: string): string {
  return `Goodbye, ${name}!`;
}

export function greet(name: string, timeOfDay: 'morning' | 'afternoon' | 'evening'): string {
  const greetings = {
    morning: 'Good morning',
    afternoon: 'Good afternoon', 
    evening: 'Good evening',
  };
  
  return `${greetings[timeOfDay]}, ${name}!`;
}

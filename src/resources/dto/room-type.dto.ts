import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateRoomTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;
}

export class UpdateRoomTypeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;
}
